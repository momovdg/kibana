/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ISuggestionItem } from '../../commands/registry/types';
import { resolveRole } from '../../esql_js_sim/definitions';
import { getCommandWindow, type CursorIR, type WrittenArgument } from '../../esql_js_sim/grammar';
import { SuggestionOrderingEngine } from '../autocomplete/utils/sorting/suggestion_ordering_engine';
import { SuggestionCategory } from '../autocomplete/utils/sorting/types';
import {
  attachReplacementRanges,
  ReplacementRangeStrategyKind,
} from '../autocomplete/utils/prefix_range';
import { getEsqlLexerTokens } from '../shared/lexer_scope';
import { getRegisteredCommand } from './command_metadata';
import { isOfExpression } from './resolve';
import type { SuggestionContext } from './types';
import { pathOf } from './written';

/** What presenting needs beyond the items: the text, the cursor, and what was read there. */
export interface Presented {
  fullText: string;
  offset: number;
  ir: CursorIR;
  context: SuggestionContext | undefined;
}

const QUOTE = '"';

let orderingEngine: SuggestionOrderingEngine | undefined;

/** Keeps the first of the items that insert the same text. */
const withoutDuplicates = (items: ISuggestionItem[]): ISuggestionItem[] => {
  const seen = new Set<string>();

  return items.filter(({ text, label }) => {
    const key = `${label}|${text}`;
    const isNew = !seen.has(key);
    seen.add(key);

    return isNew;
  });
};

/** On a line with nothing on it yet, moving to the next line is not offered. */
const withoutNewLineOnEmptyLine = (
  items: ISuggestionItem[],
  { fullText, offset }: Presented
): ISuggestionItem[] => {
  const lineStart = fullText.lastIndexOf('\n', offset - 1) + 1;
  const isAtStartOfLine = fullText.slice(lineStart, offset).trim() === '';

  return isAtStartOfLine
    ? items.filter(({ category }) => category !== SuggestionCategory.NEW_LINE)
    : items;
};

/**
 * The text each item replaces when it is chosen: the word being typed, or what an item says
 * about itself. The columns are asked for only when an item depends on the word being one.
 */
const withReplacementRanges = async (
  items: ISuggestionItem[],
  { fullText, offset, context, ir }: Presented
): Promise<ISuggestionItem[]> => {
  const innerText = fullText.slice(0, offset);

  // Inside quotes an item replaces what is typed in them. One that brings its own quotes
  // replaces the quotes too, the closing one the editor added included.
  if (ir.position === 'inside_string' && ir.word) {
    const { start } = ir.word;

    return items.map((item) => {
      const isQuoted = item.text.startsWith(QUOTE);

      return item.rangeToReplace || item.replacementRangeStrategy
        ? item
        : {
            ...item,
            rangeToReplace: {
              start: isQuoted ? start : start + QUOTE.length,
              end: isQuoted ? offset + QUOTE.length : offset,
            },
          };
    });
  }

  // While a word is typed every item replaces the word, a separator too.
  const ranged = ir.word
    ? items.map(({ replacementRangeStrategy, ...item }) =>
        replacementRangeStrategy?.kind === ReplacementRangeStrategyKind.TRAILING_WHITESPACE
          ? item
          : { ...item, replacementRangeStrategy }
      )
    : items;
  const needsColumns = items.some(({ requiresExistingColumnMatch }) => requiresExistingColumnMatch);

  return attachReplacementRanges(innerText, ranged, {
    // The tokens near the cursor are all that is read: the commands the cursor is not in
    // are not lexed again.
    tokens: getEsqlLexerTokens(getCommandWindow(innerText).text),
    commandContext: needsColumns && context ? { columns: await context.getColumnMap() } : undefined,
    fullText,
    offset,
  });
};

/**
 * The order of the items in the list, by the kind of each item. Some kinds move up or down
 * for a command, or for a clause of it: the clause is the last keyword written in the command.
 */
const inOrder = (items: ISuggestionItem[], { ir }: Presented): ISuggestionItem[] => {
  const command = ir.command === undefined ? undefined : getRegisteredCommand(ir.command);
  const [, ...afterName] = ir.written;
  // A keyword inside an expression of the command, as the filter of an aggregation, is none.
  const isInExpression = ({ ancestors }: WrittenArgument): boolean =>
    ancestors.some(
      (_, index) =>
        resolveRole(ancestors.slice(0, index + 1).map(({ id }) => id))?.role.kind === 'expression'
    );
  const clause = afterName.findLast(
    (written) =>
      written.kind === 'token' &&
      written.class === 'keyword' &&
      !isOfExpression(pathOf(written)) &&
      !isInExpression(written)
  );

  orderingEngine ??= new SuggestionOrderingEngine();

  return orderingEngine.sort(items, {
    command: command?.name.toUpperCase() ?? '',
    location: clause?.text.toUpperCase(),
  });
};

/**
 * Turns what the providers offer into what the editor shows: each item once, with the text
 * it replaces and its place in the list.
 */
export const present = async (
  items: ISuggestionItem[],
  presented: Presented
): Promise<ISuggestionItem[]> => {
  const visible = withoutNewLineOnEmptyLine(withoutDuplicates(items), presented);

  return inOrder(await withReplacementRanges(visible, presented), presented);
};
