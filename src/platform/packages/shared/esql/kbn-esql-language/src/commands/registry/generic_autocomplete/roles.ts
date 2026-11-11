/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { isOptionNode } from '@elastic/esql';
import {
  getArgumentRole,
  getCallSites,
  getTokenRole,
  getTokenRoles,
  RULE_END,
  SINGLE_USE_RULES,
  type ArgumentRole,
  type CallSite,
} from '../../../esql_js_prototype';
import { sourceExists } from '../../definitions/utils/sources';
import { getAvailableMetadataFields } from '../options/metadata';
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
  getDateHistogramCompletionItem,
  getTimeseriesDateHistogramCompletionItem,
  denseVectorLiteralCompleteItem,
  semiColonCompleteItem,
} from '../complete_items';
import {
  columns,
  constants,
  enrichFields,
  fixed,
  getEnrichPolicy,
  getSourceNames,
  identifiers,
  isInExpressionList,
  lookupIndices,
  mapEntries,
  matchingColumns,
  merged,
  metadataFields,
  newName,
  newNamedSubquery,
  none,
  optionNames,
  policies,
  recommendedQueries,
  remainingMetadataFields,
  settingNames,
  settingValues,
  sources,
  stringSnippet,
  suggestedColumnName,
  wildcard,
} from './providers';
import { isExpressionSlot } from './slot_matching';
import type { ISuggestionItem } from '../types';
import type { SlotDefinition, SlotProvider, SuggestContext } from './types';

const SEPARATOR_TOKENS = ['COMMA', 'ASSIGN', 'PIPE', 'SEMICOLON'];

/**
 * The calls of `invokes` in `rule` that can follow the token `previous`, or the one made from
 * the ATN `state` when the locator knows it, as FUSE's `GROUP BY` column, also after `BY`.
 */
const sitesAfter = (
  rule: string,
  invokes: string,
  previous: string | undefined,
  state?: number
): CallSite[] => {
  const sites = getCallSites(rule, invokes);
  const called = sites.filter((site) => state !== undefined && site.state === state);
  if (called.length) {
    return called;
  }
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
  sitesAfter(
    slot.stack[slot.stack.length - 1] ?? '',
    slot.rule,
    previousTokenName(slot),
    slot.invokingStates?.[slot.stack.length]
  );

/**
 * The positions of the argument a slot starts: the slot's own, or that of an enclosing rule
 * starting with it, whichever has a role first. At `DISSECT ` a column, a constant or a
 * function could start the argument `dissectCommand>primaryExpression`, a string column.
 */
const getArgumentSites = (slot: ExpectedRule): CallSite[] => {
  const { rule, stack, startsRules, invokingStates } = slot;
  const previous = previousTokenName(slot);
  for (let depth = 0; depth <= startsRules; depth++) {
    const invokes = depth === 0 ? rule : stack[stack.length - depth];
    const sites = sitesAfter(
      stack[stack.length - 1 - depth] ?? '',
      invokes,
      previous,
      invokingStates?.[stack.length - depth]
    );
    if (sites.some((site) => getArgumentRole(site))) {
      return sites;
    }
  }
  return getListSites(slot) ?? getSlotSites(slot);
};

/**
 * For an entry of a list rule, as the second column of HIGHLIGHT's `ON a, b`, the call of the
 * list, when it has a role: each entry is what the list holds.
 */
const getListSites = ({ rule, stack, invokingStates }: ExpectedRule): CallSite[] | undefined => {
  let entry = rule;
  for (let depth = 1; depth < stack.length; depth++) {
    const list = stack[stack.length - depth];
    const isList = getCallSites(list, entry).some(({ precededBy }) => precededBy.includes('COMMA'));
    if (!isList) {
      return undefined;
    }
    const state = invokingStates?.[stack.length - depth];
    const sites = getCallSites(stack[stack.length - 1 - depth] ?? '', list).filter(
      (site) => state === undefined || site.state === state
    );
    if (sites.some((site) => getArgumentRole(site))) {
      return sites;
    }
    entry = list;
  }
  return undefined;
};

/**
 * For a key or a value inside a command's `WITH { … }` map, the map's argument: the rule call
 * above the map with a map role, as `userAgentCommand>commandNamedParameters`. A map inside a
 * function or another map is not the command's.
 */
const MAP_ROLE_KINDS: readonly string[] = ['map', 'setting_value'];

const getMapSlot = (slot: ExpectedRule): SlotDefinition | undefined => {
  const { stack } = slot;
  const mapIndex = stack.indexOf('mapExpression');
  if (mapIndex < 1) {
    return undefined;
  }
  // The map itself, as FUSE's `WITH options=mapExpression`, or the rule calling it, as
  // `commandNamedParameters`. A setting's value may be a map of its parameters (SET).
  const site = [
    ...getCallSites(stack[mapIndex - 1], 'mapExpression'),
    ...getCallSites(stack[mapIndex - 2] ?? '', stack[mapIndex - 1]),
  ].find((candidate) => MAP_ROLE_KINDS.includes(getArgumentRole(candidate)?.kind ?? ''));
  const role = site && getArgumentRole(site);
  if (!site || !role) {
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
 * How the expression engine should treat the expression at the cursor, from the role of the
 * argument it belongs to: the types it prefers, a value control for a string such as a prompt,
 * and no columns for a constant such as MMR's query vector. Inside a function call the call's
 * own parameters apply instead.
 */
export const getExpressionOptions = (
  location: CursorLocation
): {
  types?: string[];
  valuesControl: boolean;
  noColumns: boolean;
  lookupColumns: boolean;
  subqueries: boolean;
  completeAsBoolean: boolean;
  fullTextOnlyIn?: string;
  constantArgument: boolean;
  aggregation: boolean;
  inAggregations: boolean;
  inGroupings: boolean;
  grouping: boolean;
  inAggregationCall: boolean;
} => {
  const role = getExpressionRole(location)?.role ?? getTokenExpressionRole(location);
  // The whole argument may hold subqueries, also inside a function call, as `CASE(a IN (FROM`.
  const argumentRole =
    getExpressionRole(location, { throughFunctions: true })?.role ??
    getTokenExpressionRole(location, { throughFunctions: true });
  return {
    types: argumentRole?.types,
    valuesControl: Boolean(role?.constraints?.format),
    // A constant, or a full-text search, is never a bare column.
    noColumns:
      role?.constraints?.constantOnly === 'true' || role?.constraints?.fullTextQuery === 'true',
    // A JOIN condition also reads the lookup index's columns.
    lookupColumns: role?.constraints?.columnsOf === 'joinTarget.index',
    // Subqueries as operands, as WHERE's `a IN (FROM b | KEEP a)`.
    subqueries: argumentRole?.constraints?.subqueries === 'true',
    // What follows the argument comes once it is a whole boolean, as WHERE's pipe.
    completeAsBoolean: role?.constraints?.complete === 'boolean',
    // Full-text functions only inside one function, as EVAL's `SCORE(MATCH(…))`.
    fullTextOnlyIn: argumentRole?.constraints?.fullTextOnlyIn,
    // A constant reads no column anywhere, also inside a function call, as ROW's values.
    constantArgument: isConstantArgument(location),
    // An aggregation, as STATS's: functions, never a bare column.
    aggregation: role?.constraints?.aggregation === 'true',
    // Inside STATS's aggregations or groupings, their own rules on functions and columns apply.
    inAggregations: hasRoleAbove(location, 'aggregation'),
    inGroupings: hasRoleAbove(location, 'grouping'),
    // A grouping, as STATS's `BY`: often a time bucket.
    grouping: role?.constraints?.grouping === 'true',
    // Inside a function call of an aggregation, where no role of its own applies.
    inAggregationCall: !role && hasRoleAbove(location, 'aggregation'),
  };
};

type ExpressionRole = Extract<ArgumentRole, { kind: 'expression' }>;

/** An aggregation reads as an expression with an `aggregation` constraint. */
const AGGREGATION_ROLE: ExpressionRole = {
  kind: 'expression',
  constraints: { aggregation: 'true' },
};

const asExpressionRole = (role: ArgumentRole | undefined): ExpressionRole | undefined => {
  if (role?.kind === 'expression') {
    return role;
  }
  return role?.kind === 'aggregation' ? AGGREGATION_ROLE : undefined;
};

/**
 * Whether a role above the cursor, also outside function calls, has the constraint, as the
 * aggregation around a STATS aggregation's `WHERE`.
 */
const hasRoleAbove = (location: CursorLocation, constraint: string): boolean => {
  const stacks = [
    ...location.expectedRules.map(({ stack, rule }) => [...stack, rule]),
    ...[...location.expectedTokens].map((type) => location.tokenStacks.get(type)?.rules ?? []),
  ];
  return stacks.some((rules) =>
    rules.some(
      (rule, index) =>
        index > 0 &&
        getCallSites(rules[index - 1], rule).some(
          (site) => asExpressionRole(getArgumentRole(site))?.constraints?.[constraint] === 'true'
        )
    )
  );
};

/**
 * The expression role of the argument an expression slot at the cursor is in, found by walking
 * out of the slot until a function call, e.g. RERANK's `ON` list from `RERANK "q" ON a, b = `.
 * `startsArgument`: the slot starts the whole argument, as at `COMPLETION `.
 */
const getExpressionRole = (
  { expectedRules }: CursorLocation,
  { throughFunctions = false }: { throughFunctions?: boolean } = {}
):
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
      if (rules[index] === 'functionExpression' && !throughFunctions) {
        break;
      }
      const role = getCallSites(rules[index - 1], rules[index])
        .filter(({ state }) => [state, undefined].includes(slot.invokingStates?.[index]))
        .map((site) => asExpressionRole(getArgumentRole(site)))
        .find(Boolean);
      if (role) {
        const startsArgument = !slot.continuation && rules.length - 1 - index <= slot.startsRules;
        return { role, slot, startsArgument };
      }
    }
  }
  return undefined;
};

/**
 * The expression role of the argument an expected token is in, where no expression slot is
 * expected, as the `(` after WHERE's `a IN `.
 */
const getTokenExpressionRole = (
  { expectedTokens, tokenStacks }: CursorLocation,
  { throughFunctions = false }: { throughFunctions?: boolean } = {}
): Extract<ArgumentRole, { kind: 'expression' }> | undefined => {
  for (const type of expectedTokens) {
    const rules = tokenStacks.get(type)?.rules ?? [];
    for (let index = rules.length - 1; index > 0; index--) {
      if (rules[index] === 'functionExpression' && !throughFunctions) {
        break;
      }
      const role = getCallSites(rules[index - 1], rules[index])
        .map((site) => asExpressionRole(getArgumentRole(site)))
        .find(Boolean);
      if (role) {
        return role;
      }
    }
  }
  return undefined;
};

/**
 * A literal of a type the expression engine has no example for, e.g. a vector. Read on use:
 * the items module is still loading when this one is.
 */
const typeExample = (type: string): ISuggestionItem[] =>
  type === 'dense_vector' ? [denseVectorLiteralCompleteItem] : [];

/**
 * Example values for an expression argument the cursor starts: by its format, e.g. a prompt
 * snippet at `COMPLETION `, or a literal of its type, e.g. a vector at `MMR `.
 */
export const getExpressionExamples = (ctx: SuggestContext): Promise<ISuggestionItem[]> => {
  const found = getExpressionRole(ctx.location);
  if (!found) {
    return Promise.resolve([]);
  }
  const { role, slot } = found;
  // Each entry of a grouping list, and its value after `=`, is a grouping of its own, as after
  // `BY a, ` or `BY b = `.
  const startsListEntry =
    role.constraints?.grouping === 'true' &&
    !slot.continuation &&
    ['COMMA', 'ASSIGN'].some((name) => getTokenType(name) === slot.previousTokenType) &&
    !isInExpressionList(slot);
  if (!found.startsArgument && !startsListEntry) {
    return Promise.resolve([]);
  }
  const format = role.constraints?.format;
  if (format) {
    return stringExamples(format)(ctx, slot);
  }
  // A grouping is often a time bucket, sized for the chart: `BUCKET(@timestamp, …)`.
  if (role.constraints?.grouping === 'true') {
    const { context } = ctx;
    const bucket = context?.isTimeseriesSource
      ? getTimeseriesDateHistogramCompletionItem
      : getDateHistogramCompletionItem;
    return Promise.resolve([bucket(context?.histogramBarTarget ?? 0)]);
  }
  const examples = (role.types ?? []).flatMap(typeExample);
  return Promise.resolve(examples);
};

/**
 * The argument at the cursor is a constant, as ROW's values, which have no input: a name there
 * is never a column.
 */
const isConstantArgument = (location: CursorLocation): boolean => {
  const role =
    getExpressionRole(location, { throughFunctions: true })?.role ??
    getTokenExpressionRole(location, { throughFunctions: true });
  return role?.constraints?.constantOnly === 'true';
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
  return !isConstantArgument(location) && columnExists(slot.text, context)
    ? 'expression'
    : 'new_column';
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

/**
 * Example values for a string, by what it holds: a DISSECT or GROK pattern, a separator, or the
 * text of a prompt, a search or a HIGHLIGHT query.
 */
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
    case 'highlight_text':
      return fixed([
        stringSnippet(
          i18n.translate('esqlLanguage.commands.highlight.autocomplete.queryTextPlaceholder', {
            defaultMessage: 'The text to highlight',
          })
        ),
      ]);
    default:
      return none();
  }
};

/**
 * Example values for a constant, by its type: a row count, a probability between 0 and 1, or
 * a string by its format or from its default.
 */
const exampleValues = (role: Extract<ArgumentRole, { kind: 'constant' }>): SlotProvider => {
  if (role.valueType === 'integer') {
    return constants(defaultLimitValueSuggestions);
  }
  if (role.valueType === 'double' && role.constraints?.lessThan === '1') {
    return constants(['.1', '.01', '.001']);
  }
  if (role.valueType === 'string' && role.constraints?.format) {
    return stringExamples(role.constraints.format);
  }
  // A string with a default, e.g. HIGHLIGHT's prefix, starts from it.
  if (role.valueType === 'string' && role.default !== undefined) {
    return fixed([stringSnippet(role.default)]);
  }
  return none();
};

/**
 * A constraint of a role on the calls above a slot, up to its command, as TS's `indexMode` on
 * its argument list. A subquery's command has its own constraints.
 */
const getConstraintAbove = (rules: string[], constraint: string): string | undefined => {
  for (let index = rules.length - 1; index > 0; index--) {
    const caller = rules[index - 1];
    for (const site of getCallSites(caller, rules[index])) {
      const role = getArgumentRole(site);
      const value = role && 'constraints' in role ? role.constraints?.[constraint] : undefined;
      if (value !== undefined) {
        return value;
      }
    }
    if (caller.endsWith('Command')) {
      return undefined;
    }
  }
  return undefined;
};

const indexModeAt = ({ stack, rule }: ExpectedRule): string | undefined =>
  getConstraintAbove([...stack, rule], 'indexMode');

/** The provider for a role of a bare-token argument, as a METADATA field or a LET name. */
const tokenProviderFor = (
  role: ArgumentRole
): ((ctx: SuggestContext) => Promise<ISuggestionItem[]>) | undefined => {
  if (role.kind === 'entity' && role.entityType === 'metadata_field') {
    return metadataFields;
  }
  return role.kind === 'new_entity' ? newNamedSubquery : undefined;
};

/** The roles of the bare-token arguments expected at the cursor, as METADATA's fields. */
const tokenRolesAt = ({ expectedTokens, tokenStacks }: CursorLocation): ArgumentRole[] =>
  [...expectedTokens].flatMap((type) => {
    const rule = tokenStacks.get(type)?.rules.at(-1);
    const role = rule && getTokenRole(rule, getTokenName(type));
    return role ? [role] : [];
  });

/** The items for the bare-token arguments expected at the cursor, as METADATA's fields. */
export const getTokenRoleItems = async (ctx: SuggestContext): Promise<ISuggestionItem[]> => {
  const items = await Promise.all(
    tokenRolesAt(ctx.location).map((role) => tokenProviderFor(role)?.(ctx) ?? [])
  );
  return items.flat();
};

/**
 * What a role adds after a complete argument, as the recommended queries after a source. A
 * list's comma is expected right after one of its entries, so the list the comma continues
 * says what was completed.
 */
export const getArgumentFollowUps = async (ctx: SuggestContext): Promise<ISuggestionItem[]> => {
  const { expectedTokens, tokenStacks } = ctx.location;
  const comma = getTokenType('COMMA');
  const rules = expectedTokens.has(comma) ? tokenStacks.get(comma)?.rules ?? [] : [];
  if (rules.length < 2) {
    return [];
  }
  const roles = getCallSites(rules[rules.length - 2], rules[rules.length - 1]).map(getArgumentRole);
  const listsSources = roles.some(
    (role) => role?.kind === 'entity' && role.entityType === 'source'
  );
  return listsSources ? recommendedQueries(ctx, getConstraintAbove(rules, 'indexMode')) : [];
};

/**
 * Leaves out the comma of a list whose entries may each appear once when none is left, as after
 * every METADATA field.
 */
export const withoutExhaustedLists = (
  keywords: KeywordItem[],
  ctx: SuggestContext
): KeywordItem[] =>
  keywords.filter(({ token }) => {
    if (token !== 'COMMA') {
      return true;
    }
    const rule = ctx.location.tokenStacks.get(getTokenType(token))?.rules.at(-1) ?? '';
    const exhausted = getTokenRoles(rule).some(
      (role) =>
        role.kind === 'entity' &&
        role.entityType === 'metadata_field' &&
        role.constraints?.unique === 'true' &&
        remainingMetadataFields(ctx).length === 0
    );
    return !exhausted;
  });

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
      const typed = columns({
        types: role.types,
        options: {
          openSuggestions: true,
          ...(isFollowedByArgument(site) && { advanceCursor: true }),
        },
      });
      return role.constraints?.wildcard === 'alone' ? merged(wildcard(), typed) : typed;
    case 'new_column':
      // A name Kibana suggests at the position, else `name = ` where an assignment follows;
      // otherwise the name is typed freely.
      return (
        (site.label &&
          suggestedColumnName(`${site.rule}.${site.label}`, {
            comma: site.followedBy.includes('COMMA') && !site.followedBy.includes(RULE_END),
          })) ||
        // In a field list (EVAL, ROW), where an expression may come instead of the name, the
        // name being typed also gets its `=`, as `b = `. In STATS the word is almost always an
        // aggregation or a column being typed, so not there.
        (site.followedBy.includes('ASSIGN')
          ? (ctx, slot) =>
              newName({
                whileTyped:
                  site.rule === 'field' &&
                  !hasRoleAbove(ctx.location, 'aggregation') &&
                  !hasRoleAbove(ctx.location, 'grouping'),
              })(ctx, slot)
          : none())
      );
    case 'constant':
      return role.valueType === 'identifier'
        ? identifiers(`${site.rule}.${site.label}`, role.allowedValues ?? [])
        : exampleValues(role);
    case 'option_name':
      return optionNames(role.allowedValues);
    case 'map':
      return mapEntries(site.rule, role.parameters);
    case 'setting_value':
      return settingValues();
    case 'entity':
      if (role.entityType === 'enrich_policy') {
        return policies();
      }
      if (role.entityType === 'lookup_index') {
        return lookupIndices();
      }
      if (role.entityType === 'setting') {
        return settingNames();
      }
      if (role.entityType === 'source') {
        return (ctx, slot) => sources({ indexMode: indexModeAt(slot) })(ctx, slot);
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
 * Whether only the statement's `;` may follow a value at the slot, as SET's value: its call
 * ends `setField`, which only `;` follows in `setCommand`.
 */
export const endsStatement = ({
  rule,
  stack,
  invokingStates,
}: Pick<ExpectedRule, 'rule' | 'stack' | 'invokingStates'>): boolean => {
  let invokes = rule;
  for (let index = stack.length - 1; index >= 0; index--) {
    const state = invokingStates?.[index + 1];
    const sites = getCallSites(stack[index], invokes).filter(
      (site) => state === undefined || site.state === state
    );
    const follows = new Set(sites.flatMap(({ followedBy }) => followedBy));
    if (follows.size !== 1) {
      return false;
    }
    if (follows.has('SEMICOLON')) {
      return true;
    }
    if (!follows.has(RULE_END)) {
      return false;
    }
    invokes = stack[index];
  }
  return false;
};

/**
 * Whether the expected token opens a value only the statement's `;` may follow, as LET's `(`:
 * its rule starts right after the previous token and ends the statement. SET's `=` doesn't:
 * it is inside `setField`.
 */
export const opensStatementEnd = (
  { tokenStacks, previousTokenType }: CursorLocation,
  token: string
): boolean => {
  const rules = tokenStacks.get(getTokenType(token))?.rules ?? [];
  const [caller, rule] = rules.slice(-2);
  if (!caller || !rule || previousTokenType === undefined) {
    return false;
  }
  const previous = getTokenName(previousTokenType);
  return (
    getCallSites(caller, rule).some(({ precededBy }) => precededBy.includes(previous)) &&
    endsStatement({ rule, stack: rules.slice(0, -1) })
  );
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
 * name (a new column) or are not looked up. A source is looked up among those of the index mode
 * its command requires; patterns, exclusions and selectors count as existing.
 */
const isExistingAs = (
  role: ArgumentRole | undefined,
  name: string,
  ctx: SuggestContext,
  indexMode?: string
): boolean | undefined => {
  if (role?.kind === 'entity' && role.entityType === 'source') {
    return sourceExists(name, getSourceNames(ctx, indexMode));
  }
  if (role?.kind === 'entity' && role.entityType === 'metadata_field') {
    return getAvailableMetadataFields(ctx.callbacks?.isServerless).includes(name);
  }
  if (role?.kind === 'column') {
    return columnExists(name, ctx.context);
  }
  if (role?.kind === 'entity' && role.entityType === 'enrich_field') {
    return getEnrichPolicy(ctx)?.enrichFields.includes(unescapeColumnName(name));
  }
  if (role?.kind === 'entity' && role.entityType === 'enrich_policy') {
    return ctx.context?.policies?.has(unescapeColumnName(name));
  }
  if (role?.kind === 'entity' && role.entityType === 'lookup_index') {
    return ctx.context?.joinSources?.some(
      (source) => source.name === name || source.aliases.includes(name)
    );
  }
  return undefined;
};

const NAME_RULES = ['qualifiedName', 'qualifiedNamePattern', 'enrichPolicyName', 'indexPattern'];

/**
 * The whole source name typed: the cluster prefix or the name before a selector, which the
 * slot continues, with the word, as `cl:idx` or `idx::data`.
 */
const sourceNameTyped = (slot: ExpectedRule, name: string, location: CursorLocation): string =>
  slot.continuation && !location.whitespaceBefore ? `${slot.text}${name}` : name;

/**
 * Whether `name` fills one of the slots or bare-token arguments expected at the cursor with
 * something that exists: a column, or what the role looks up (an enrich field, a policy, a
 * source, a METADATA field).
 */
export const isCompleteName = (name: string, ctx: SuggestContext): boolean =>
  ctx.location.expectedRules.some((slot) => {
    // A constant's names are new columns, never existing ones, as in ROW.
    if (
      !NAME_RULES.includes(slot.rule) ||
      (isExpressionSlot(slot) && isConstantArgument(ctx.location))
    ) {
      return false;
    }
    const roles = getSlotSites(slot).map(getArgumentRole);
    return roles.some(Boolean)
      ? roles.some((role) =>
          role?.kind === 'entity' && role.entityType === 'source'
            ? isExistingAs(role, sourceNameTyped(slot, name, ctx.location), ctx, indexModeAt(slot))
            : isExistingAs(role, name, ctx)
        )
      : columnExists(name, ctx.context);
  }) || tokenRolesAt(ctx.location).some((role) => isExistingAs(role, name, ctx));

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

/**
 * Leaves out the clauses the command already has where the grammar repeats a rule whose
 * alternatives may each appear once, as a second `SCORE BY` in FUSE.
 */
export const withoutUsedClauses = (
  keywords: KeywordItem[],
  { location, command }: SuggestContext
): KeywordItem[] => {
  const used = new Set(
    command.args.flatMap((arg) =>
      !Array.isArray(arg) && isOptionNode(arg) ? [arg.name.toLowerCase()] : []
    )
  );
  return keywords.filter(({ token, item }) => {
    const rules = location.tokenStacks.get(getTokenType(token))?.rules ?? [];
    const singleUse = rules.some((rule) => SINGLE_USE_RULES.includes(rule));
    return !singleUse || !used.has(item.label.toLowerCase());
  });
};
