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
  getGrammarLabels,
  RULE_END,
  RULE_START,
  type ArgumentRole,
  type GrammarLabel,
} from '../../../esql_js_prototype';
import { getTokenName } from '../../../language/shared/cursor_location/cursor_location';
import type { ExpectedRule } from '../../../language/shared/cursor_location/types';
import { columnExists } from '../../definitions/utils/autocomplete/helpers';
import { unescapeColumnName } from '../../definitions/utils/shared';
import { getMappedKeywordTokens, type KeywordItem } from '../keyword_items';
import {
  columns,
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
 * The labelled grammar positions a slot can be, told apart by the token before it: in
 * `RENAME a AS `, only `newName`; at `RENAME `, both `oldName` and `newName`.
 */
export const getSlotLabels = ({ rule, stack, previousTokenType }: ExpectedRule): GrammarLabel[] => {
  const labels = getGrammarLabels(stack[stack.length - 1] ?? '', rule);
  const previous = previousTokenType === undefined ? undefined : getTokenName(previousTokenType);
  const exact = labels.filter(
    ({ precededBy }) => previous !== undefined && precededBy.includes(previous)
  );
  return exact.length ? exact : labels.filter(({ precededBy }) => precededBy.includes(RULE_START));
};

/** A keyword follows the slot in the grammar, so moving the cursor past the value helps. */
const isFollowedByKeyword = ({ followedBy }: GrammarLabel): boolean => {
  const keywords = getMappedKeywordTokens();
  return followedBy.some((token) => keywords.has(token) && !SEPARATOR_TOKENS.includes(token));
};

/** The editor's provider for a role. Roles describe the language; this decides what to show. */
const providerFor = (role: ArgumentRole, label: GrammarLabel): SlotProvider => {
  switch (role.kind) {
    case 'column':
      // A column matching another argument, e.g. ENRICH's ON and the policy's match field.
      if (role.constraints?.matches) {
        return matchingColumns();
      }
      return columns(
        isFollowedByKeyword(label)
          ? { options: { advanceCursor: true, openSuggestions: true } }
          : {}
      );
    case 'new_column':
      // `name = ` where an assignment follows; otherwise the name is typed freely.
      return label.followedBy.includes('ASSIGN') ? newName() : none();
    case 'entity':
      if (role.entityType === 'enrich_policy') {
        return policies();
      }
      return role.entityType === 'enrich_field' ? enrichFields() : none();
    default:
      return none();
  }
};

/** The slot definition given by the roles of the slot's labels, when all of them have one. */
export const getRoleSlot = (slot: ExpectedRule): SlotDefinition | undefined => {
  const labels = getSlotLabels(slot);
  const providers: SlotProvider[] = [];
  for (const label of labels) {
    const role = getArgumentRole(label);
    if (!role) {
      return undefined;
    }
    providers.push(providerFor(role, label));
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
    const labels = getSlotLabels(slot);
    return labels.length
      ? labels.some((label) => isExistingAs(getArgumentRole(label), name, ctx))
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
  const labels = slot ? getSlotLabels(slot) : [];
  if (!slot || !labels.length) {
    return keywords;
  }

  // The labels a keyword reads the name as. Tokens after the clause, like a comma or the pipe,
  // belong to the labels that can end it.
  const readingOf = (token: string): GrammarLabel[] => {
    const owners = labels.filter(({ followedBy }) => followedBy.includes(token));
    return owners.length
      ? owners
      : labels.filter(({ followedBy }) => followedBy.includes(RULE_END));
  };
  const readings = keywords.map(({ token }) => readingOf(token));
  const distinct = new Set(readings.map((reading) => reading.map(({ state }) => state).join()));
  if (distinct.size <= 1) {
    return keywords;
  }

  const found = readings.map((reading) =>
    reading.map((label) => isExistingAs(getArgumentRole(label), slot.text, ctx))
  );
  // Prefer a reading that finds the name; otherwise drop those that need an existing one.
  if (found.some((results) => results.includes(true))) {
    return keywords.filter((_, index) => found[index].includes(true));
  }
  return keywords.filter(
    (_, index) => !found[index].includes(false) || found[index].includes(undefined)
  );
};
