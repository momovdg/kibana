/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import {
  getArgumentRole,
  getCallSites,
  RULE_END,
  type ArgumentRole,
  type CallSite,
} from '../../../esql_js_prototype';
import {
  getTokenName,
  getTokenType,
} from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation, ExpectedRule } from '../../../language/shared/cursor_location/types';
import { columnExists } from '../../definitions/utils/autocomplete/helpers';
import { unescapeColumnName } from '../../definitions/utils/shared';
import { getMappedKeywordTokens, type KeywordItem } from '../keyword_items';
import {
  colonCompleteItem,
  defaultLimitValueSuggestions,
  semiColonCompleteItem,
} from '../complete_items';
import {
  columns,
  constants,
  enrichFields,
  fixed,
  getEnrichPolicy,
  mapEntries,
  matchingColumns,
  merged,
  newName,
  none,
  optionNames,
  policies,
  stringSnippet,
  suggestedColumnName,
} from './providers';
import { isExpressionSlot } from './slot_matching';
import type { ISuggestionItem } from '../types';
import type { SlotDefinition, SlotProvider, SuggestContext } from './types';

const SEPARATOR_TOKENS = ['COMMA', 'ASSIGN', 'PIPE', 'SEMICOLON'];

/** The calls of `invokes` in `rule` that can follow the token `previous`. */
const sitesAfter = (rule: string, invokes: string, previous: string | undefined): CallSite[] => {
  const sites = getCallSites(rule, invokes);
  const exact = sites.filter(
    ({ precededBy }) => previous !== undefined && precededBy.includes(previous)
  );
  // Without one, the token ended the rule's start (`<start>`) or a `<rule>` call.
  return exact.length
    ? exact
    : sites.filter(({ precededBy }) => precededBy.some((before) => before.startsWith('<')));
};

const previousTokenName = ({ previousTokenType }: ExpectedRule): string | undefined =>
  previousTokenType === undefined ? undefined : getTokenName(previousTokenType);

/**
 * The grammar positions a slot can be, told apart by the token before it: in `RENAME a AS `,
 * only `newName`; at `RENAME `, both `oldName` and `newName`. Without a site after that token,
 * the token ended the rule's start or a rule call, as the column before GROK's pattern.
 */
export const getSlotSites = (slot: ExpectedRule): CallSite[] =>
  sitesAfter(slot.stack[slot.stack.length - 1] ?? '', slot.rule, previousTokenName(slot));

/**
 * The positions of the argument a slot starts: the slot's own, or that of an enclosing rule
 * starting with it, whichever has a role first. At `DISSECT ` a column, a constant or a
 * function could start the argument `dissectCommand>primaryExpression`, a string column.
 */
const getArgumentSites = (slot: ExpectedRule): CallSite[] => {
  const { rule, stack, startsRules } = slot;
  const previous = previousTokenName(slot);
  for (let depth = 0; depth <= startsRules; depth++) {
    const invokes = depth === 0 ? rule : stack[stack.length - depth];
    const sites = sitesAfter(stack[stack.length - 1 - depth] ?? '', invokes, previous);
    if (sites.some((site) => getArgumentRole(site))) {
      return sites;
    }
  }
  return getSlotSites(slot);
};

/**
 * For a key or a value inside a command's `WITH { … }` map, the map's argument: the rule call
 * above the map with a map role, as `userAgentCommand>commandNamedParameters`. A map inside a
 * function or another map is not the command's.
 */
const getMapSlot = (slot: ExpectedRule): SlotDefinition | undefined => {
  const { stack } = slot;
  const mapIndex = stack.indexOf('mapExpression');
  if (mapIndex < 1) {
    return undefined;
  }
  const site = getCallSites(stack[mapIndex - 2] ?? '', stack[mapIndex - 1]).find(
    (candidate) => getArgumentRole(candidate)?.kind === 'map'
  );
  const role = site && getArgumentRole(site);
  if (!site || role?.kind !== 'map') {
    return undefined;
  }
  const nested = stack.indexOf('mapExpression', mapIndex + 1) >= 0;
  return {
    rule: slot.rule,
    argument: `${site.rule}>${site.invokes}`,
    provide: nested ? none() : providerFor(role, site),
  };
};

/**
 * The types an expression role prefers for the expression at the cursor, e.g. a string for
 * USER_AGENT's input. Inside a function call the argument's own types apply instead.
 */
/**
 * How the expression engine should treat the expression at the cursor, from the role of the
 * argument it belongs to: the types it prefers, and a value control for a string such as a
 * prompt. Inside a function call the call's own parameters apply instead.
 */
export const getExpressionOptions = (
  location: CursorLocation
): { types?: string[]; valuesControl: boolean } => {
  const role = getExpressionRole(location)?.role;
  return { types: role?.types, valuesControl: Boolean(role?.constraints?.format) };
};

/**
 * The expression role of the argument an expression slot at the cursor is in, found by walking
 * out of the slot until a function call, e.g. RERANK's `ON` list from `RERANK "q" ON a, b = `.
 * `startsArgument`: the slot starts the whole argument, as at `COMPLETION `.
 */
const getExpressionRole = ({
  expectedRules,
}: CursorLocation):
  | {
      role: Extract<ArgumentRole, { kind: 'expression' }>;
      slot: ExpectedRule;
      startsArgument: boolean;
    }
  | undefined => {
  for (const slot of expectedRules) {
    if (!isExpressionSlot(slot)) {
      continue;
    }
    const rules = [...slot.stack, slot.rule];
    for (let index = rules.length - 1; index > 0; index--) {
      if (rules[index] === 'functionExpression') {
        break;
      }
      const role = getCallSites(rules[index - 1], rules[index])
        .map(getArgumentRole)
        .find((candidate) => candidate?.kind === 'expression');
      if (role?.kind === 'expression') {
        const startsArgument = !slot.continuation && rules.length - 1 - index <= slot.startsRules;
        return { role, slot, startsArgument };
      }
    }
  }
  return undefined;
};

/**
 * Example strings for an expression argument the cursor starts, by its format, e.g. a prompt
 * snippet at `COMPLETION `.
 */
export const getExpressionExamples = (ctx: SuggestContext): Promise<ISuggestionItem[]> => {
  const found = getExpressionRole(ctx.location);
  const format = found?.role.constraints?.format;
  return found && format && found.startsArgument
    ? stringExamples(format)(ctx, found.slot)
    : Promise.resolve([]);
};

/**
 * A bare name that continues an expression where `=` may also follow, as `COMPLETION x ` or
 * `RERANK "q" ON x `: `=` reads it as a new column, anything else as the expression, where it
 * must be an existing column. An existing column is read as the expression, any other name as
 * a new column.
 */
export const getNameReading = ({
  location,
  context,
}: SuggestContext): 'new_column' | 'expression' | undefined => {
  if (location.partial || !location.expectedTokens.has(getTokenType('ASSIGN'))) {
    return undefined;
  }
  const slot = location.expectedRules.find(
    (candidate) =>
      candidate.continuation && candidate.rule === 'qualifiedName' && isExpressionSlot(candidate)
  );
  if (!slot) {
    return undefined;
  }
  // A parameter (`?`, `?name`) is a value, never a new column's name.
  if (slot.text.startsWith('?')) {
    return 'expression';
  }
  return columnExists(slot.text, context) ? 'expression' : 'new_column';
};

/** Roles the expression engine fills. */
const isExpressionRole = ({ kind }: ArgumentRole): boolean =>
  kind === 'expression' || kind === 'aggregation';

/**
 * Something other than an expression follows the slot in the grammar, a keyword as AS in
 * `RENAME a AS b` or another argument as DISSECT's pattern, so moving the cursor past the
 * value helps.
 */
const isFollowedByArgument = ({ followedBy }: CallSite): boolean => {
  const keywords = getMappedKeywordTokens();
  return followedBy.some(
    (token) =>
      (keywords.has(token) && !SEPARATOR_TOKENS.includes(token)) ||
      (token.startsWith('<') && token !== RULE_END)
  );
};

const patternDetail = () =>
  i18n.translate('esqlLanguage.esql.autocomplete.aPatternString', {
    defaultMessage: 'A pattern string',
  });

/** Example values for a string, by what it holds: a DISSECT or GROK pattern, or a separator. */
const stringExamples = (format: string | undefined): SlotProvider => {
  switch (format) {
    case 'dissect_pattern':
      return constants(['"%{firstWord}"'], patternDetail());
    case 'grok_pattern':
      return async (ctx, slot) => {
        const name = slot.previousTokenType === getTokenType('COMMA') ? 'nextWord' : 'firstWord';
        return constants([`"%{WORD:${name}}"`], patternDetail())(ctx, slot);
      };
    case 'separator':
      return fixed([colonCompleteItem, semiColonCompleteItem]);
    case 'llm_prompt':
      return fixed([stringSnippet('Your prompt to the LLM.')]);
    case 'search_query':
      return fixed([stringSnippet('Your search query')]);
    default:
      return none();
  }
};

/**
 * Example values for a constant, by its type: a row count, a probability between 0 and 1, or
 * a string by its format.
 */
const exampleValues = (role: Extract<ArgumentRole, { kind: 'constant' }>): SlotProvider => {
  if (role.valueType === 'integer') {
    return constants(defaultLimitValueSuggestions);
  }
  if (role.valueType === 'double' && role.constraints?.lessThan === '1') {
    return constants(['.1', '.01', '.001']);
  }
  if (role.valueType === 'string') {
    return stringExamples(role.constraints?.format);
  }
  return none();
};

/**
 * The editor's provider for a role at a call site. Roles describe the language; this decides
 * what to show.
 */
const providerFor = (role: ArgumentRole, site: CallSite): SlotProvider => {
  switch (role.kind) {
    case 'column':
      // A column matching another argument, e.g. ENRICH's ON and the policy's match field.
      if (role.constraints?.matches) {
        return matchingColumns();
      }
      // The list reopens after a column, with what follows it; the cursor moves on when a
      // keyword or another argument has to follow.
      return columns({
        types: role.types,
        options: {
          openSuggestions: true,
          ...(isFollowedByArgument(site) && { advanceCursor: true }),
        },
      });
    case 'new_column':
      // A name Kibana suggests at the position, else `name = ` where an assignment follows;
      // otherwise the name is typed freely.
      return (
        (site.label &&
          suggestedColumnName(`${site.rule}.${site.label}`, {
            comma: site.followedBy.includes('COMMA') && !site.followedBy.includes(RULE_END),
          })) ||
        (site.followedBy.includes('ASSIGN') ? newName() : none())
      );
    case 'constant':
      return exampleValues(role);
    case 'option_name':
      return optionNames(role.allowedValues);
    case 'map':
      return mapEntries(site.rule, role.parameters);
    case 'entity':
      if (role.entityType === 'enrich_policy') {
        return policies();
      }
      return role.entityType === 'enrich_field' ? enrichFields() : none();
    default:
      return none();
  }
};

/**
 * The slot definition given by the roles of the argument the slot starts, when each of its
 * positions has one. Expression roles are left to the expression engine.
 */
export const getRoleSlot = (slot: ExpectedRule): SlotDefinition | undefined => {
  const mapSlot = getMapSlot(slot);
  if (mapSlot) {
    return mapSlot;
  }
  const sites = getArgumentSites(slot);
  const providers: SlotProvider[] = [];
  for (const site of sites) {
    const role = getArgumentRole(site);
    if (!role || isExpressionRole(role)) {
      return undefined;
    }
    providers.push(providerFor(role, site));
  }
  if (!providers.length) {
    return undefined;
  }
  const [{ rule, invokes }] = sites;
  return {
    rule: slot.rule,
    argument: `${rule}>${invokes}:${sites.map(({ state }) => state).join()}`,
    provide: merged(...providers),
  };
};

/**
 * Whether a role other than an expression covers a token the rules `stack` expect, as the
 * `::` after `DISSECT col `: the argument is a column, so no expression continues it.
 */
export const isCoveredByRole = (stack: string[]): boolean =>
  stack.some((rule, index) =>
    getCallSites(stack[index - 1] ?? '', rule).some((site) => {
      const role = getArgumentRole(site);
      return role !== undefined && !isExpressionRole(role);
    })
  );

/**
 * Whether `name` is an existing thing of the role's kind, or undefined for roles that take any
 * name (a new column) or are not looked up.
 */
const isExistingAs = (
  role: ArgumentRole | undefined,
  name: string,
  ctx: SuggestContext
): boolean | undefined => {
  if (role?.kind === 'column') {
    return columnExists(name, ctx.context);
  }
  if (role?.kind === 'entity' && role.entityType === 'enrich_field') {
    return getEnrichPolicy(ctx)?.enrichFields.includes(unescapeColumnName(name));
  }
  if (role?.kind === 'entity' && role.entityType === 'enrich_policy') {
    return ctx.context?.policies?.has(unescapeColumnName(name));
  }
  return undefined;
};

const NAME_RULES = ['qualifiedName', 'qualifiedNamePattern', 'enrichPolicyName'];

/**
 * Whether `name` fills one of the slots expected at the cursor with something that exists: a
 * column, or what the slot's role looks up (an enrich field, a policy).
 */
export const isCompleteName = (name: string, ctx: SuggestContext): boolean =>
  ctx.location.expectedRules.some((slot) => {
    if (!NAME_RULES.includes(slot.rule)) {
      return false;
    }
    const roles = getSlotSites(slot).map(getArgumentRole);
    return roles.some(Boolean)
      ? roles.some((role) => isExistingAs(role, name, ctx))
      : columnExists(name, ctx.context);
  });

/**
 * Chooses between readings of the name just typed when the keywords after it imply different
 * ones. In `RENAME bytes `, `AS` reads `bytes` as an existing column and `=` as a new one: an
 * existing column keeps only `AS`, any other name only `=`. With a single reading, as in
 * `RENAME a = b `, every keyword stays.
 */
export const filterKeywordsByRoles = (
  keywords: KeywordItem[],
  ctx: SuggestContext
): KeywordItem[] => {
  const { location } = ctx;
  if (location.partial) {
    return keywords;
  }
  const nameReading = getNameReading(ctx);
  if (nameReading) {
    const assigns = nameReading === 'new_column';
    return keywords.filter(({ token }) => (token === 'ASSIGN') === assigns);
  }
  // Every position the name typed may fill, as DENSE_VECTOR's `field ` (a target before `=`
  // or the first column of the list).
  const slots = location.expectedRules.filter(
    (candidate) => candidate.continuation && !isExpressionSlot(candidate)
  );
  const [slot] = slots;
  if (!slot) {
    return keywords;
  }
  // A keyword may also read the name as a position the locator does not report, as `=` after
  // DENSE_VECTOR's target: a call of the same rule, after the same token, that the keyword
  // follows in its own rule.
  const previous = previousTokenName(slot);
  const keywordSites = keywords.flatMap(({ token }) => {
    const parent = location.tokenStacks.get(getTokenType(token))?.rules.at(-1);
    return parent
      ? sitesAfter(parent, slot.rule, previous).filter(({ followedBy }) =>
          followedBy.includes(token)
        )
      : [];
  });
  const sites = [...slots.flatMap(getSlotSites), ...keywordSites].filter(
    (site, index, all) => all.findIndex(({ state }) => state === site.state) === index
  );
  if (!sites.some((site) => getArgumentRole(site))) {
    return keywords;
  }

  // The call sites a keyword reads the name as. Tokens after the clause, like a comma or the
  // pipe, belong to the sites that can end it.
  const readingOf = (token: string): CallSite[] => {
    const owners = sites.filter(({ followedBy }) => followedBy.includes(token));
    return owners.length ? owners : sites.filter(({ followedBy }) => followedBy.includes(RULE_END));
  };
  const readings = keywords.map(({ token }) => readingOf(token));
  const distinct = new Set(readings.map((reading) => reading.map(({ state }) => state).join()));
  if (distinct.size <= 1) {
    return keywords;
  }

  const found = readings.map((reading) =>
    reading.map((site) => isExistingAs(getArgumentRole(site), slot.text, ctx))
  );
  // Prefer a reading that finds the name; otherwise drop those that need an existing one.
  if (found.some((results) => results.includes(true))) {
    return keywords.filter((_, index) => found[index].includes(true));
  }
  return keywords.filter(
    (_, index) => !found[index].includes(false) || found[index].includes(undefined)
  );
};
