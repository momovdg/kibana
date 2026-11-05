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
import { getMappedKeywordTokens, type KeywordItem } from '../keyword_items';
import type { ICommandContext } from '../types';
import { columns, merged, newName, none, policies } from './providers';
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
      return columns(
        isFollowedByKeyword(label)
          ? { options: { advanceCursor: true, openSuggestions: true } }
          : {}
      );
    case 'new_column':
      // `name = ` where an assignment follows; otherwise the name is typed freely.
      return label.followedBy.includes('ASSIGN') ? newName() : none();
    case 'entity':
      return role.entityType === 'enrich_policy' ? policies() : none();
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

const accepts = (role: ArgumentRole | undefined, name: string, context?: ICommandContext) =>
  role?.kind !== 'column' || columnExists(name, context);

/**
 * Leaves out the keywords that would make the name just typed something it cannot be: in
 * `RENAME field `, `AS` makes `field` an existing column, so it needs one.
 */
export const filterKeywordsByRoles = (
  keywords: KeywordItem[],
  { location, context }: SuggestContext
): KeywordItem[] => {
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

  return keywords.filter(({ token }) => {
    const owners = labels.filter(({ followedBy }) => followedBy.includes(token));
    // Tokens after the clause, like a comma or the pipe, belong to the labels that can end it.
    const deciding = owners.length
      ? owners
      : labels.filter(({ followedBy }) => followedBy.includes(RULE_END));
    return (
      !deciding.length ||
      deciding.some((label) => accepts(getArgumentRole(label), slot.text, context))
    );
  });
};
