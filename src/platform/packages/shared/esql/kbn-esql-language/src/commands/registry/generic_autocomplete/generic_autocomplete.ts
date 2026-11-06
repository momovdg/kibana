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
  getTokenName,
  getTokenType,
  locateCursor,
} from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation } from '../../../language/shared/cursor_location/types';
import { newLineCompleteItem } from '../complete_items';
import {
  EXPRESSION_ENGINE_TOKENS,
  getMappedKeywordTokens,
  keywordsAt,
  type KeywordItem,
} from '../keyword_items';
import { ReplacementRangeStrategyKind } from '../../../language/autocomplete/utils/prefix_range';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem } from '../types';
import { DEFAULT_SLOTS, suggestExpression } from './providers';
import { isExpressionSlot, matchSlots } from './slot_matching';
import {
  filterKeywordsByRoles,
  getExpressionExamples,
  getExpressionOptions,
  getNameReading,
  getRoleSlot,
  isCompleteName,
  isCoveredByRole,
  withoutUsedClauses,
} from './roles';
import type { CommandAutocompleteSpec, SuggestContext } from './types';

export type CommandAutocomplete = (
  query: string,
  command: ESQLAstAllCommands,
  callbacks?: ICommandCallbacks,
  context?: ICommandContext,
  cursorPosition?: number
) => Promise<ISuggestionItem[]>;

/** Tokens after which an item can follow directly: operators, openers and separators. */
const SEPARATING_TOKENS = [
  'COMMA',
  'ASSIGN',
  'PIPE',
  'SEMICOLON',
  'COLON',
  'DOT',
  'CAST_OP',
  'ARROW',
  'LP',
  'OPENING_BRACKET',
  'LEFT_BRACES',
  'EQ',
  'CIEQ',
  'NEQ',
  'LT',
  'LTE',
  'GT',
  'GTE',
  'PLUS',
  'MINUS',
  'ASTERISK',
  'SLASH',
  'PERCENT',
];

const SEPARATOR_TOKENS = ['COMMA', 'ASSIGN', 'SEMICOLON'];

/** Rules a `*` may end, as a name pattern. */
const NAME_RULES = ['qualifiedNamePattern', 'identifierPattern'];

const CLOSING_TOKENS = ['RP', 'CLOSING_BRACKET', 'RIGHT_BRACES'];

/** Tokens a value always follows in the language, whatever the grammar allows after them. */
const VALUE_INTRODUCING_TOKENS = ['ASSIGN', 'ON'];

const needsLeadingSpace = ({ token, item }: KeywordItem): boolean =>
  !SEPARATOR_TOKENS.includes(token) && item !== newLineCompleteItem;

/**
 * Nothing separates the cursor from the value before it, e.g. `SORT (col)` or `` `a b` ``. A
 * `*` that ends a name pattern, as in HIGHLIGHT's `ON *` or KEEP's `text*`, is part of the
 * value, not the multiplication operator.
 */
const isGluedToValue = ({
  partial,
  whitespaceBefore,
  previousTokenType,
  expectedRules,
}: CursorLocation) =>
  !partial &&
  !whitespaceBefore &&
  previousTokenType !== undefined &&
  (!SEPARATING_TOKENS.some((name) => getTokenType(name) === previousTokenType) ||
    (previousTokenType === getTokenType('ASTERISK') &&
      expectedRules.some(({ rule, continuation }) => continuation && NAME_RULES.includes(rule))));

const toItem = (keyword: KeywordItem, location: CursorLocation): ISuggestionItem => {
  if (isGluedToValue(location) && needsLeadingSpace(keyword)) {
    return { ...keyword.item, text: ` ${keyword.item.text}` };
  }
  // `a , ` reads badly: a comma after whitespace replaces it.
  if (keyword.token === 'COMMA' && location.whitespaceBefore && !location.partial) {
    return {
      ...keyword.item,
      replacementRangeStrategy: { kind: ReplacementRangeStrategyKind.TRAILING_WHITESPACE },
    };
  }
  return keyword.item;
};

/**
 * What follows a complete word, keeping the word: `asc NULLS FIRST`, `host, `, `host | `, and
 * a new line after `host` (without the word, the item would replace it).
 */
const toFollowUp = (keyword: KeywordItem): ISuggestionItem => ({
  ...keyword.item,
  text: needsLeadingSpace(keyword) ? ` ${keyword.item.text}` : keyword.item.text,
  preserveTypedPrefix: true,
});

/** The name typed so far: a dotted prefix the word continues (`kubernetes.`), then the word. */
const typedName = ({ partial, expectedRules, previousTokenType }: CursorLocation): string => {
  const prefix =
    previousTokenType === getTokenType('DOT')
      ? expectedRules.find(({ continuation }) => continuation)?.text ?? ''
      : '';
  return `${prefix}${partial?.text ?? ''}`;
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
    const adjustKeywords = (keywords: KeywordItem[], at: SuggestContext) => {
      const allowed = filterKeywordsByRoles(withoutUsedClauses(keywords, at), at);
      return spec.keywords ? spec.keywords(allowed, at) : allowed;
    };

    const slotMatches = matchSlots(location, {
      command: spec.slots,
      fromRoles: getRoleSlot,
      defaults: DEFAULT_SLOTS,
    });

    // A complete word, a keyword the grammar expects or an existing name, gets only what can
    // follow it, when something can: `asc` → `asc NULLS FIRST`, `bytes` → `bytes, `.
    if (location.partial) {
      const keywords = getMappedKeywordTokens();
      const expectsKeyword = [...location.expectedTokens].some((type) =>
        keywords.has(getTokenName(type))
      );
      const completesSlot = isCompleteName(typedName(location), ctx);
      // The word's token depends on the lexer mode, so it is read from the position after it.
      if (expectsKeyword || completesSlot) {
        const after = locateCursor(`${query.slice(0, cursorPosition)} `, cursorPosition + 1);
        // Inside unclosed parentheses, as in `TRIM(col`, the expression continues instead.
        const isNested = !after.commandCanEnd && after.expectedTokens.has(getTokenType('RP'));
        const word = after.previousTokenType;
        const isCompleteKeyword =
          word !== undefined &&
          location.expectedTokens.has(word) &&
          keywords.has(getTokenName(word));
        const followUps =
          (isCompleteKeyword || completesSlot) && !isNested
            ? adjustKeywords(keywordsAt(after), { ...ctx, location: after })
            : [];
        if (followUps.length) {
          return withoutDuplicates(followUps.map(toFollowUp));
        }
        // A keyword typed in full that nothing listed follows, as `WITH` before `{`: only the
        // keywords fit the word, so the editor can complete it.
        if (isCompleteKeyword && !completesSlot && !isNested) {
          return withoutDuplicates(
            adjustKeywords(keywordsAt(location), ctx).map((keyword) => toItem(keyword, location))
          );
        }
      }
    }

    return withoutDuplicates(await suggestAt(ctx, spec, slotMatches, adjustKeywords));
  };

/** The slot, expression and keyword items for the position before the word being typed. */
const suggestAt = async (
  ctx: SuggestContext,
  spec: CommandAutocompleteSpec,
  slotMatches: ReturnType<typeof matchSlots>,
  adjustKeywords: (keywords: KeywordItem[], at: SuggestContext) => KeywordItem[]
): Promise<ISuggestionItem[]> => {
  const { location } = ctx;
  const slotItems = await Promise.all(
    slotMatches.map(({ slot, definition }) => definition.provide(ctx, slot))
  );
  // An expression slot, or a token only expressions take, like an operator after `SORT (col) `
  // or `NULL` after `IS NOT `. Right after a value such as `(col)`, only what follows it.
  // A closing `)` is no sign of an expression: it may close a FORK branch or a subquery.
  // Where a role says what the argument is, as the column of `DISSECT `, the role fills it.
  const inExpression =
    location.expectedRules.some((slot) => isExpressionSlot(slot) && !getRoleSlot(slot)) ||
    [...location.expectedTokens].some((type) => {
      const name = getTokenName(type);
      return (
        EXPRESSION_ENGINE_TOKENS.has(name) &&
        !CLOSING_TOKENS.includes(name) &&
        !isCoveredByRole(location.tokenStacks.get(type)?.rules ?? [])
      );
    });
  // A name that can only be a new column, as `COMPLETION x `, continues no expression.
  const expressionItems =
    inExpression && !isGluedToValue(location) && getNameReading(ctx) !== 'new_column'
      ? await suggestExpression(ctx, spec.expression, getExpressionOptions(location))
      : [];
  const exampleItems =
    inExpression && !isGluedToValue(location) ? await getExpressionExamples(ctx) : [];
  const valueItems = [...slotItems.flat(), ...expressionItems, ...exampleItems];

  // Right after `=` or `ON` something has to follow, even where the grammar leaves it out, as
  // after `DENSE_VECTOR vec = `: when something can fill the position, only that.
  const needsValue =
    valueItems.length > 0 &&
    VALUE_INTRODUCING_TOKENS.some((name) => getTokenType(name) === location.previousTokenType);
  const keywordItems = needsValue
    ? []
    : adjustKeywords(keywordsAt(location), ctx).map((keyword) => toItem(keyword, location));

  return [...valueItems, ...keywordItems];
};
