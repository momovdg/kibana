/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLAstAllCommands, ESQLSingleAstItem } from '@elastic/esql/types';
import { isColumn } from '@elastic/esql';
import { withAutoSuggest } from '../../definitions/utils/autocomplete/helpers';
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation } from '../../../language/shared/cursor_location/types';
import { newLineCompleteItem, pipeCompleteItem, commaCompleteItem } from '../complete_items';
import type { ISuggestionItem } from '../types';
import { ReplacementRangeStrategyKind } from '../../../language/autocomplete/utils/prefix_range';

export type SortPosition =
  | 'expression'
  | 'order_complete'
  | 'after_order'
  | 'nulls_complete'
  | 'after_nulls';

const isTypedKeyword = (partial: CursorLocation['partial'], keywords: string[]): boolean =>
  partial !== undefined && keywords.includes(partial.text.toUpperCase());

/** Maps the grammar's view of the cursor to a SORT position. */
export const getSortPos = (
  { partial, previousTokenType, whitespaceBefore }: CursorLocation,
  command: ESQLAstAllCommands
): { position: SortPosition | undefined; expressionRoot: ESQLSingleAstItem | undefined } => {
  const lastArg = command.args[command.args.length - 1];
  const afterComma = previousTokenType === getTokenType('COMMA') && whitespaceBefore && !partial;
  const hasExpressionArg = lastArg && !Array.isArray(lastArg) && lastArg.type !== 'order';

  // Expression context: no arg, after comma, or within an expression (not order node)
  if (!lastArg || afterComma || hasExpressionArg) {
    const expressionRoot = hasExpressionArg && !afterComma ? lastArg : undefined;

    return { position: 'expression', expressionRoot };
  }

  const previousIs = (...names: string[]) =>
    names.some((name) => previousTokenType === getTokenType(name));

  if (isTypedKeyword(partial, ['ASC', 'DESC'])) {
    return { position: 'order_complete', expressionRoot: undefined };
  }

  if (previousIs('NULLS')) {
    return {
      position: isTypedKeyword(partial, ['FIRST', 'LAST']) ? 'nulls_complete' : 'after_order',
      expressionRoot: undefined,
    };
  }

  if (previousIs('ASC', 'DESC')) {
    return { position: 'after_order', expressionRoot: undefined };
  }

  if (previousIs('FIRST', 'LAST') && !partial) {
    return { position: 'after_nulls', expressionRoot: undefined };
  }

  return { position: undefined, expressionRoot: undefined };
};

export const sortModifierSuggestions = {
  ASC: withAutoSuggest({
    label: 'ASC',
    text: 'ASC',
    detail: '',
    kind: 'Keyword',
  }),
  DESC: withAutoSuggest({
    label: 'DESC',
    text: 'DESC',
    detail: '',
    kind: 'Keyword',
  }),
  NULLS_FIRST: withAutoSuggest({
    label: 'NULLS FIRST',
    text: 'NULLS FIRST',
    detail: '',
    kind: 'Keyword',
  }),
  NULLS_LAST: withAutoSuggest({
    label: 'NULLS LAST',
    text: 'NULLS LAST',
    detail: '',
    kind: 'Keyword',
  }),
};

export const rightAfterColumn = (
  expressionRoot: ESQLSingleAstItem | undefined,
  columnExists: (name: string) => boolean,
  { partial, previousTokenType, whitespaceBefore }: CursorLocation,
  cursorPosition: number
): boolean => {
  return (
    isColumn(expressionRoot) &&
    columnExists(expressionRoot.parts.join('.')) &&
    // this prevents the branch from being entered for something like "SORT column NULLS LA/"
    // where the "NULLS LA" won't be in the AST so expressionRoot will just be the column
    (expressionRoot.location.max + 1 === cursorPosition ||
      // the AST drops the parentheses of "SORT (column)"
      (!partial && !whitespaceBefore && previousTokenType === getTokenType('RP')))
  );
};

export const getSuggestionsAfterCompleteExpression = (
  location: CursorLocation,
  expressionRoot: ESQLSingleAstItem | undefined,
  columnExists: (name: string) => boolean,
  cursorPosition: number
): ISuggestionItem[] => {
  let sortCommandKeywordSuggestions = [
    { ...sortModifierSuggestions.ASC },
    { ...sortModifierSuggestions.DESC },
    { ...sortModifierSuggestions.NULLS_FIRST },
    { ...sortModifierSuggestions.NULLS_LAST },
  ];

  const pipeSuggestion = { ...pipeCompleteItem };
  const commaSuggestion = withAutoSuggest({
    ...commaCompleteItem,
    text: ', ',
  });

  // is the cursor after whitespace or a comment?
  if (location.whitespaceBefore && !location.partial) {
    commaSuggestion.replacementRangeStrategy = {
      kind: ReplacementRangeStrategyKind.TRAILING_WHITESPACE,
    };
  }
  // special case: cursor right after a column name
  else if (rightAfterColumn(expressionRoot, columnExists, location, cursorPosition)) {
    sortCommandKeywordSuggestions = sortCommandKeywordSuggestions.map((s) => ({
      ...s,
      text: ` ${s.text}`,
      preserveTypedPrefix: true,
    }));

    pipeSuggestion.text = ` ${pipeSuggestion.text}`;
    pipeSuggestion.preserveTypedPrefix = true;

    commaSuggestion.preserveTypedPrefix = true;
  }

  return [...sortCommandKeywordSuggestions, newLineCompleteItem, pipeSuggestion, commaSuggestion];
};
