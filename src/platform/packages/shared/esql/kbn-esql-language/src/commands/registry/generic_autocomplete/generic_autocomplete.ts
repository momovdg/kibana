/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLAstAllCommands } from '@elastic/esql/types';
import {
  getTokenType,
  locateCursor,
} from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation } from '../../../language/shared/cursor_location/types';
import { newLineCompleteItem } from '../complete_items';
import { keywordsAt, type KeywordItem } from '../keyword_items';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem } from '../types';
import { DEFAULT_SLOTS, suggestExpression } from './providers';
import { isExpressionSlot, matchSlots } from './slot_matching';
import type { CommandAutocompleteSpec, SuggestContext } from './types';

export type CommandAutocomplete = (
  query: string,
  command: ESQLAstAllCommands,
  callbacks?: ICommandCallbacks,
  context?: ICommandContext,
  cursorPosition?: number
) => Promise<ISuggestionItem[]>;

/** Tokens that end a value, so an item typed right after them needs a leading space. */
const VALUE_END_TOKENS = [
  'RP',
  'CLOSING_BRACKET',
  'RIGHT_BRACES',
  'QUOTED_IDENTIFIER',
  'QUOTED_STRING',
];

const SEPARATOR_TOKENS = ['COMMA', 'ASSIGN', 'SEMICOLON'];

const needsLeadingSpace = ({ token, item }: KeywordItem): boolean =>
  !SEPARATOR_TOKENS.includes(token) && item !== newLineCompleteItem;

/** Nothing separates the cursor from the value before it, e.g. `SORT (col)`. */
const isGluedToValue = ({ partial, whitespaceBefore, previousTokenType }: CursorLocation) =>
  !partial &&
  !whitespaceBefore &&
  VALUE_END_TOKENS.some((name) => getTokenType(name) === previousTokenType);

const toItem = (keyword: KeywordItem, glued: boolean): ISuggestionItem =>
  glued && needsLeadingSpace(keyword)
    ? { ...keyword.item, text: ` ${keyword.item.text}` }
    : keyword.item;

/**
 * What follows a complete word, keeping the word: `asc NULLS FIRST`, `host, `, `host | `. For
 * a column, `attachReplacementRanges` keeps these only when the word is an existing column.
 */
const toFollowUp = (
  keyword: KeywordItem,
  requiresExistingColumnMatch: boolean
): ISuggestionItem => {
  if (keyword.item === newLineCompleteItem) {
    return requiresExistingColumnMatch
      ? { ...keyword.item, requiresExistingColumnMatch }
      : keyword.item;
  }
  return {
    ...keyword.item,
    text: needsLeadingSpace(keyword) ? ` ${keyword.item.text}` : keyword.item.text,
    preserveTypedPrefix: true,
    ...(requiresExistingColumnMatch && { requiresExistingColumnMatch }),
  };
};

const withoutDuplicates = (items: ISuggestionItem[]): ISuggestionItem[] => {
  const seen = new Set<string>();
  return items.filter(({ text }) => !seen.has(text) && Boolean(seen.add(text)));
};

/** An autocomplete that fills the slots and keywords the grammar expects, as `spec` declares. */
export const createGenericAutocomplete =
  (getSpec: (command: ESQLAstAllCommands) => CommandAutocompleteSpec): CommandAutocomplete =>
  async (query, command, callbacks, context, cursorPosition = query.length) => {
    const location = context?.cursorLocation ?? locateCursor(query, cursorPosition);
    // Inside a comment, or after characters the lexer dropped, nothing fits.
    if (location.inComment || location.skippedText) {
      return [];
    }

    const spec = getSpec(command);
    const ctx: SuggestContext = { query, command, cursorPosition, location, callbacks, context };
    const adjustKeywords = (keywords: KeywordItem[], at: SuggestContext) =>
      spec.keywords ? spec.keywords(keywords, at) : keywords;

    const slotMatches = matchSlots(location, [...(spec.slots ?? []), ...DEFAULT_SLOTS]);

    const keywordFollowUps = spec.keywordFollowUps ?? [];
    const columnFollowUps = slotMatches.some(({ definition }) => definition.followUps);

    // A word typed in full may be followed by more keywords; locate the cursor after it.
    if (location.partial && (keywordFollowUps.length || columnFollowUps)) {
      const after = locateCursor(`${query.slice(0, cursorPosition)} `, cursorPosition + 1);
      const afterCtx = { ...ctx, location: after };
      const word = after.previousTokenType;
      const isCompleteKeyword =
        word !== undefined &&
        location.expectedTokens.has(word) &&
        keywordFollowUps.some((name) => getTokenType(name) === word);

      if (isCompleteKeyword) {
        return adjustKeywords(keywordsAt(after), afterCtx).map((keyword) =>
          toFollowUp(keyword, false)
        );
      }

      if (columnFollowUps) {
        const followUps = adjustKeywords(keywordsAt(after), afterCtx).map((keyword) =>
          toFollowUp(keyword, true)
        );
        return withoutDuplicates([...followUps, ...(await suggestAt(ctx, spec, slotMatches))]);
      }
    }

    return withoutDuplicates(await suggestAt(ctx, spec, slotMatches));
  };

/** The slot, expression and keyword items for the position before the word being typed. */
const suggestAt = async (
  ctx: SuggestContext,
  spec: CommandAutocompleteSpec,
  slotMatches: ReturnType<typeof matchSlots>
): Promise<ISuggestionItem[]> => {
  const { location } = ctx;
  const slotItems = await Promise.all(
    slotMatches.map(({ slot, definition }) => definition.provide(ctx, slot))
  );
  const expressionItems =
    spec.expression && location.expectedRules.some(isExpressionSlot)
      ? await suggestExpression(ctx, spec.expression)
      : [];
  const keywords = keywordsAt(location);
  const glued = isGluedToValue(location);
  const keywordItems = (spec.keywords ? spec.keywords(keywords, ctx) : keywords).map((keyword) =>
    toItem(keyword, glued)
  );

  return [...slotItems.flat(), ...expressionItems, ...keywordItems];
};
