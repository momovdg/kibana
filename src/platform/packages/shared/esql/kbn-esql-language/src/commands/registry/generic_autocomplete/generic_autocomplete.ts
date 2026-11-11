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
import { ARGUMENT_REQUIRED_COMMANDS } from '../../../esql_js_prototype';
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
  endsStatement,
  filterKeywordsByRoles,
  getArgumentFollowUps,
  getExpressionExamples,
  getExpressionOptions,
  getNameReading,
  getRoleSlot,
  getTokenRoleItems,
  isCompleteName,
  isCoveredByRole,
  opensStatementEnd,
  withoutExhaustedLists,
  withoutUsedClauses,
} from './roles';
import type { CommandAutocompleteSpec, SuggestContext } from './types';
import { lazyContextFromEager } from '../../../language/autocomplete/lazy_context';
import type { ExpressionComputedMetadata } from '../../definitions/utils/autocomplete/expressions/types';

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

/**
 * An item that continues after a complete word, keeping it. An item with no text, as a
 * standalone recommended query that its command writes, stays as it is.
 */
const keepingWord = (item: ISuggestionItem): ISuggestionItem =>
  item.text ? { ...item, preserveTypedPrefix: true } : item;

/** A `;` right after the cursor already ends the statement, as in `SET a = ^;`. */
const isStatementEndAhead = ({ query, cursorPosition }: SuggestContext): boolean =>
  /^\s*;/.test(query.slice(cursorPosition));

const LITERAL_TOKENS = ['TRUE', 'FALSE', 'INTEGER_LITERAL', 'DECIMAL_LITERAL'];

/**
 * The word typed is a whole literal in a slot a role fills, and no value the role offers
 * continues it: `SET a = true` is done, while `LIMIT 1` may still become `10`.
 */
const isCompleteLiteral = async (
  ctx: SuggestContext,
  slotMatches: ReturnType<typeof matchSlots>
): Promise<boolean> => {
  const { location, query, cursorPosition } = ctx;
  const typed = location.partial?.text;
  if (!typed || !slotMatches.length) {
    return false;
  }
  const after = locateCursor(`${query.slice(0, cursorPosition)} `, cursorPosition + 1);
  const isLiteral = LITERAL_TOKENS.some((name) => getTokenType(name) === after.previousTokenType);
  if (!isLiteral) {
    return false;
  }
  const items = (
    await Promise.all(slotMatches.map(({ slot, definition }) => definition.provide(ctx, slot)))
  ).flat();
  return !items.some(({ text }) => text !== typed && text.startsWith(typed));
};

/** The name typed so far: a dotted prefix the word continues (`kubernetes.`), then the word. */
const typedName = ({ partial, expectedRules, previousTokenType }: CursorLocation): string => {
  const prefix =
    previousTokenType === getTokenType('DOT')
      ? expectedRules.find(({ continuation }) => continuation)?.text ?? ''
      : '';
  return `${prefix}${partial?.text ?? ''}`;
};

/**
 * The items without repeats. Actions insert no text, as "Choose from the time picker" and
 * "Create control", so an item is its label and text together.
 */
const withoutDuplicates = (items: ISuggestionItem[]): ISuggestionItem[] => {
  const seen = new Set<string>();
  return items.filter(({ label, text }) => {
    const key = `${label}\u0000${text}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
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
    const ctx: SuggestContext = {
      query,
      command,
      cursorPosition,
      location,
      callbacks,
      context,
      resources: context?.resources ?? lazyContextFromEager(context),
    };
    const statementEndAhead = isStatementEndAhead(ctx);
    const adjustKeywords = async (keywords: KeywordItem[], at: SuggestContext) => {
      const notAhead = statementEndAhead
        ? keywords.filter(({ token }) => token !== 'SEMICOLON')
        : keywords;
      const allowed = await filterKeywordsByRoles(
        withoutExhaustedLists(withoutUsedClauses(notAhead, at), at),
        at
      );
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
      const completesLiteral = await isCompleteLiteral(ctx, slotMatches);
      const completesSlot = (await isCompleteName(typedName(location), ctx)) || completesLiteral;
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
        const keywordFollowUps =
          (isCompleteKeyword || completesSlot) && !isNested
            ? await adjustKeywords(keywordsAt(after), { ...ctx, location: after })
            : [];
        // A complete name inside an expression continues with operators, as `bytes > $0`.
        const expressionFollowUps =
          completesSlot && !completesLiteral && !isNested
            ? await getExpressionFollowUps(ctx, spec, after)
            : undefined;
        const argumentDone = expressionFollowUps?.argumentDone !== false;
        // What the argument's role adds after it, as the recommended queries after a source.
        const argumentFollowUps =
          completesSlot && !isNested && argumentDone
            ? await getArgumentFollowUps({ ...ctx, location: after })
            : [];
        const followUps = [
          ...(expressionFollowUps?.items ?? []),
          ...(argumentDone ? keywordFollowUps : []).map(toFollowUp),
          ...argumentFollowUps.map(keepingWord),
        ];
        if (followUps.length) {
          return withoutDuplicates(followUps);
        }
        // A whole literal nothing follows here, as `SET a = 123` before a `;`.
        if (completesLiteral && !isNested) {
          return [];
        }
        // A keyword typed in full that nothing listed follows, as `WITH` before `{`: only the
        // keywords fit the word, so the editor can complete it.
        if (isCompleteKeyword && !completesSlot && !isNested) {
          return withoutDuplicates(
            (await adjustKeywords(keywordsAt(location), ctx)).map((keyword) =>
              toItem(keyword, location)
            )
          );
        }
      }
    }

    return withoutDuplicates(await suggestAt(ctx, spec, slotMatches, adjustKeywords));
  };

/**
 * An expression slot, or a token only expressions take, like an operator after `SORT (col) `
 * or `NULL` after `IS NOT `. A closing `)` is no sign of an expression: it may close a FORK
 * branch or a subquery. Where a role says what the argument is, as the column of `DISSECT `,
 * the role fills it, and a token the keyword table maps here, as FORK's `(`, is a keyword.
 */
const isInExpression = (location: CursorLocation): boolean => {
  if (location.expectedRules.some((slot) => isExpressionSlot(slot) && !getRoleSlot(slot))) {
    return true;
  }
  const keywordTokens = new Set(keywordsAt(location).map(({ token }) => token));
  return [...location.expectedTokens].some((type) => {
    const name = getTokenName(type);
    return (
      EXPRESSION_ENGINE_TOKENS.has(name) &&
      !CLOSING_TOKENS.includes(name) &&
      !keywordTokens.has(name) &&
      !isCoveredByRole(location.tokenStacks.get(type)?.rules ?? [])
    );
  });
};

/**
 * A command that needs an argument has none yet, though the grammar lets it end, as `STATS `:
 * Elasticsearch needs an aggregation or a grouping.
 */
const needsArgument = ({ command, location, cursorPosition }: SuggestContext): boolean =>
  // The word being typed is not an argument yet.
  command.args.every(
    (arg) => Array.isArray(arg) || arg.location.min >= (location.partial?.start ?? cursorPosition)
  ) &&
  [...location.expectedRules.flatMap(({ stack }) => stack)].some((rule) =>
    ARGUMENT_REQUIRED_COMMANDS.includes(rule)
  );

/** The expression is complete, outside any function call. */
const isComplete = (computed: ExpressionComputedMetadata | undefined): boolean =>
  Boolean(computed?.isComplete) && !computed?.insideFunction;

/** The expression is a whole boolean, outside any function call. */
const isWholeBoolean = (computed: ExpressionComputedMetadata | undefined): boolean =>
  computed?.expressionType === 'boolean' && computed.isComplete && !computed.insideFunction;

/**
 * After a complete name in an expression, the operators that continue it, keeping the name
 * (`bytes > $0`), and whether the argument is complete, for what follows it.
 */
const getExpressionFollowUps = async (
  ctx: SuggestContext,
  spec: CommandAutocompleteSpec,
  after: CursorLocation
): Promise<{ items: ISuggestionItem[]; argumentDone: boolean } | undefined> => {
  if (!isInExpression(after)) {
    return undefined;
  }
  const { query, cursorPosition } = ctx;
  const atAfter: SuggestContext = {
    ...ctx,
    query: `${query.slice(0, cursorPosition)} `,
    cursorPosition: cursorPosition + 1,
    location: after,
  };
  const options = getExpressionOptions(after);
  const { suggestions, computed } = await suggestExpression(atAfter, spec.expression, options);
  return {
    items: suggestions.map((item) => ({
      ...item,
      text: ` ${item.text}`,
      preserveTypedPrefix: true,
    })),
    argumentDone: !options.completeAsBoolean || isWholeBoolean(computed),
  };
};

/** The slot, expression and keyword items for the position before the word being typed. */
const suggestAt = async (
  ctx: SuggestContext,
  spec: CommandAutocompleteSpec,
  slotMatches: ReturnType<typeof matchSlots>,
  adjustKeywords: (keywords: KeywordItem[], at: SuggestContext) => Promise<KeywordItem[]>
): Promise<ISuggestionItem[]> => {
  const { location } = ctx;
  // A value only the statement's `;` may follow ends it, as SET's `"_alias:*";`, unless the `;`
  // is already there or the value fills an open string's quotes.
  const endStatement = !isStatementEndAhead(ctx) && !location.partial?.text.startsWith('"');
  const slotItems = await Promise.all(
    slotMatches.map(async ({ slot, definition }) => {
      const items = await definition.provide(ctx, slot);
      return endStatement && endsStatement(slot)
        ? items.map((item) => ({ ...item, text: `${item.text};` }))
        : items;
    })
  );
  const inExpression = isInExpression(location);
  const glued = isGluedToValue(location);
  const options = getExpressionOptions(location);
  // A name that can only be a new column, as `COMPLETION x `, continues no expression.
  const expression =
    inExpression && getNameReading(ctx) !== 'new_column'
      ? await suggestExpression(ctx, spec.expression, options)
      : undefined;
  // Right after a complete value, as `(a IN (…))`, only the operators that continue it, spaced,
  // and a function's next-argument comma.
  const expressionItems = !expression
    ? []
    : !glued
    ? expression.suggestions
    : expression.suggestions.flatMap((item) => {
        if (item.kind === 'Operator') {
          return [{ ...item, text: ` ${item.text}` }];
        }
        return item.text.trim() === ',' ? [item] : [];
      });
  const exampleItems = inExpression && !glued ? await getExpressionExamples(ctx) : [];
  // Arguments that are bare tokens, as METADATA's fields.
  const tokenItems = await getTokenRoleItems(ctx);
  const valueItems = [...slotItems.flat(), ...tokenItems, ...expressionItems, ...exampleItems];

  // Right after `=` or `ON` something has to follow, even where the grammar leaves it out, as
  // after `DENSE_VECTOR vec = `: when something can fill the position, only that.
  const needsValue =
    valueItems.length > 0 &&
    VALUE_INTRODUCING_TOKENS.some((name) => getTokenType(name) === location.previousTokenType);
  // An argument complete only as a boolean, as WHERE's, is followed by nothing until it is one;
  // an aggregation, until it is a complete one, as not `AVG(counter)` outside TS.
  const argumentDone =
    (!options.completeAsBoolean || isWholeBoolean(expression?.computed)) &&
    (!options.aggregation ||
      expression?.computed.position === 'empty_expression' ||
      isComplete(expression?.computed));
  // Inside an open string, as KQL's `"""…`, no keyword fits.
  const inString = location.partial?.text.startsWith('"') ?? false;
  // Inside a function call the expression engine offers the comma between arguments.
  const insideFunction = Boolean(expression?.computed.insideFunction);
  const offersKeywords = !needsValue && argumentDone && !inString && !insideFunction;
  const keywordItems = offersKeywords
    ? (await adjustKeywords(keywordsAt(location), ctx))
        // A command that needs an argument and has none cannot end yet, as `STATS `.
        .filter(({ token }) => !(token === 'PIPE' && needsArgument(ctx)))
        .map((keyword) => {
          const item = toItem(keyword, location);
          // A keyword opening the statement's last value ends it too, as LET's `(FROM …);`.
          return endStatement && opensStatementEnd(location, keyword.token)
            ? { ...item, text: `${item.text};` }
            : item;
        })
    : [];
  // What the role of the argument just completed adds, as the recommended queries after a source.
  // While a word is typed, as `METADATA`, nothing has been completed yet: a complete name gets
  // them as follow-ups instead.
  const argumentFollowUps =
    offersKeywords && !location.partial ? await getArgumentFollowUps(ctx) : [];

  return [...valueItems, ...keywordItems, ...argumentFollowUps];
};
