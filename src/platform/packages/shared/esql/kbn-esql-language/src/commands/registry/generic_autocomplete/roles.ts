/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import {
  getArgumentRole,
  getCallSites,
  RULE_END,
  type ArgumentRole,
  type CallSite,
} from '../../../esql_js_prototype';
import { getTokenName } from '../../../language/shared/cursor_location/cursor_location';
import type { ExpectedRule } from '../../../language/shared/cursor_location/types';
import { columnExists } from '../../definitions/utils/autocomplete/helpers';
import { unescapeColumnName } from '../../definitions/utils/shared';
import { getMappedKeywordTokens, type KeywordItem } from '../keyword_items';
import { defaultLimitValueSuggestions } from '../complete_items';
import {
  columns,
  constants,
  enrichFields,
  getEnrichPolicy,
  matchingColumns,
  merged,
  newName,
  none,
  policies,
} from './providers';
import { isExpressionSlot } from './slot_matching';
import type { SlotDefinition, SlotProvider, SuggestContext } from './types';

const SEPARATOR_TOKENS = ['COMMA', 'ASSIGN', 'PIPE', 'SEMICOLON'];

/**
 * The grammar positions a slot can be, told apart by the token before it: in `RENAME a AS `,
 * only `newName`; at `RENAME `, both `oldName` and `newName`. Without a site after that token,
 * the token ended the rule's start or a rule call, as the column before GROK's pattern.
 */
export const getSlotSites = ({ rule, stack, previousTokenType }: ExpectedRule): CallSite[] => {
  const sites = getCallSites(stack[stack.length - 1] ?? '', rule);
  const previous = previousTokenType === undefined ? undefined : getTokenName(previousTokenType);
  const exact = sites.filter(
    ({ precededBy }) => previous !== undefined && precededBy.includes(previous)
  );
  // `<start>` or a `<rule>` call.
  return exact.length
    ? exact
    : sites.filter(({ precededBy }) => precededBy.some((before) => before.startsWith('<')));
};

/** A keyword follows the slot in the grammar, so moving the cursor past the value helps. */
const isFollowedByKeyword = ({ followedBy }: CallSite): boolean => {
  const keywords = getMappedKeywordTokens();
  return followedBy.some((token) => keywords.has(token) && !SEPARATOR_TOKENS.includes(token));
};

/** Example values for a constant, by its type: a row count, or a probability between 0 and 1. */
const exampleValues = (role: Extract<ArgumentRole, { kind: 'constant' }>): string[] => {
  if (role.valueType === 'integer') {
    return defaultLimitValueSuggestions;
  }
  if (role.valueType === 'double' && role.constraints?.lessThan === '1') {
    return ['.1', '.01', '.001'];
  }
  return [];
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
      // keyword has to follow, as AS in `RENAME a AS b`.
      return columns({
        options: {
          openSuggestions: true,
          ...(isFollowedByKeyword(site) && { advanceCursor: true }),
        },
      });
    case 'new_column':
      // `name = ` where an assignment follows; otherwise the name is typed freely.
      return site.followedBy.includes('ASSIGN') ? newName() : none();
    case 'constant':
      return constants(exampleValues(role));
    case 'entity':
      if (role.entityType === 'enrich_policy') {
        return policies();
      }
      return role.entityType === 'enrich_field' ? enrichFields() : none();
    default:
      return none();
  }
};

/** The slot definition given by the roles of the slot's call sites, when all of them have one. */
export const getRoleSlot = (slot: ExpectedRule): SlotDefinition | undefined => {
  const providers: SlotProvider[] = [];
  for (const site of getSlotSites(slot)) {
    const role = getArgumentRole(site);
    if (!role) {
      return undefined;
    }
    providers.push(providerFor(role, site));
  }
  return providers.length ? { rule: slot.rule, provide: merged(...providers) } : undefined;
};

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
  const slot = location.expectedRules.find(
    (candidate) => candidate.continuation && !isExpressionSlot(candidate)
  );
  const sites = slot ? getSlotSites(slot) : [];
  if (!slot || !sites.some((site) => getArgumentRole(site))) {
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
