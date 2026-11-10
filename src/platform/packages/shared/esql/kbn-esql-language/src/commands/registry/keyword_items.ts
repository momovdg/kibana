/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Parser } from '@elastic/esql';
import { Token } from 'antlr4';
import type { CursorLocation } from '../../language/shared/cursor_location/types';
import { withAutoSuggest } from '../definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from './types';
import {
  asCompletionItem,
  assignCompletionItem,
  byCompleteItem,
  commaCompleteItem,
  forkNewBranchCompleteItem,
  fuseGroupByCompleteItem,
  fuseKeyByCompleteItem,
  fuseScoreByCompleteItem,
  inlineStatsKeywordCompleteItem,
  joinKeywordCompleteItem,
  joinOnCompleteItem,
  mmrLimitKeywordSuggestion,
  newLineAndPipeCompleteItems,
  onCompleteItem,
  statementEndCompleteItem,
  showInfoCompleteItem,
  whereCompleteItem,
  withCompleteItem,
} from './complete_items';
import { onSuggestion, withSuggestion } from './enrich/util';
import { metadataSuggestion } from './options/metadata';
import { sortModifierSuggestions } from './sort/utils';

interface KeywordEntry {
  /** Grammar token name, e.g. `NULLS`. */
  token: string;
  /** The command rule the entry is limited to, e.g. `enrichCommand`; without it, the default. */
  command?: string;
  items: ISuggestionItem[];
}

/** A keyword or separator item for an expected token. */
export interface KeywordItem {
  token: string;
  item: ISuggestionItem;
}

/** The words after the first of a multi-word item, e.g. `FIRST` from `NULLS FIRST`. */
const remainderOf = (item: ISuggestionItem): ISuggestionItem => ({
  ...item,
  label: item.label.split(' ').slice(1).join(' '),
  text: item.text.split(' ').slice(1).join(' '),
});

/**
 * Items for the keyword and separator tokens the grammar expects inside a command. Command
 * entries keep the items those commands suggest today; Section 2's migrations may merge them.
 * Built on first use, as some items come from command modules that import this one indirectly.
 */
const buildKeywordEntries = (): readonly KeywordEntry[] => [
  { token: 'PIPE', items: newLineAndPipeCompleteItems },
  { token: 'COMMA', items: [withAutoSuggest({ ...commaCompleteItem, text: ', ' })] },
  { token: 'ASSIGN', items: [assignCompletionItem] },
  // The grammar's `;` only ends a header statement (SET).
  { token: 'SEMICOLON', items: [statementEndCompleteItem] },
  { token: 'AS', items: [asCompletionItem] },
  // A JOIN qualifier (`idx AS q`) is not offered: Elasticsearch may not support it yet.
  { token: 'AS', command: 'joinCommand', items: [] },
  { token: 'JOIN', items: [joinKeywordCompleteItem] },
  { token: 'INLINE_STATS', items: [inlineStatsKeywordCompleteItem] },
  { token: 'BY', items: [byCompleteItem] },
  { token: 'WHERE', items: [whereCompleteItem] },
  { token: 'ON', items: [onCompleteItem] },
  { token: 'ON', command: 'enrichCommand', items: [onSuggestion] },
  { token: 'ON', command: 'joinCommand', items: [joinOnCompleteItem] },
  { token: 'WITH', items: [withCompleteItem] },
  { token: 'WITH', command: 'enrichCommand', items: [withSuggestion] },
  { token: 'METADATA', items: [metadataSuggestion] },
  // FORK's `(` opens a branch, not an expression.
  { token: 'LP', command: 'forkCommand', items: [forkNewBranchCompleteItem] },
  { token: 'INFO', items: [showInfoCompleteItem] },
  { token: 'MMR_LIMIT', items: [mmrLimitKeywordSuggestion] },
  { token: 'SCORE', items: [fuseScoreByCompleteItem] },
  { token: 'GROUP', items: [fuseGroupByCompleteItem] },
  { token: 'KEY', items: [fuseKeyByCompleteItem] },
  { token: 'ASC', items: [sortModifierSuggestions.ASC] },
  { token: 'DESC', items: [sortModifierSuggestions.DESC] },
  {
    token: 'NULLS',
    items: [sortModifierSuggestions.NULLS_FIRST, sortModifierSuggestions.NULLS_LAST],
  },
  // In the middle of `NULLS FIRST` and `NULLS LAST`, the words left to type.
  { token: 'FIRST', items: [remainderOf(sortModifierSuggestions.NULLS_FIRST)] },
  { token: 'LAST', items: [remainderOf(sortModifierSuggestions.NULLS_LAST)] },
];

let keywordEntries: readonly KeywordEntry[] | undefined;
const getKeywordEntries = (): readonly KeywordEntry[] => (keywordEntries ??= buildKeywordEntries());

/**
 * Operators, brackets, literals and parameters: the grammar allows them after any expression,
 * and the expression engine suggests them.
 */
export const EXPRESSION_ENGINE_TOKENS: ReadonlySet<string> = new Set([
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'LIKE',
  'RLIKE',
  'CAST_OP',
  'COLON',
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
  'LP',
  'RP',
  'LEFT_BRACES',
  'RIGHT_BRACES',
  'OPENING_BRACKET',
  'CLOSING_BRACKET',
  'DOT',
  'ARROW',
  'NULL',
  'TRUE',
  'FALSE',
  'PARAM',
  'DOUBLE_PARAMS',
  'NAMED_OR_POSITIONAL_PARAM',
  'NAMED_OR_POSITIONAL_DOUBLE_PARAMS',
]);

/** Tokens the user never picks from a list. */
export const IGNORED_TOKENS: ReadonlySet<string> = new Set(['EOF']);

let symbolicNames: Array<string | null> | undefined;

const tokenName = (type: number): string => {
  if (type === Token.EOF) {
    return 'EOF';
  }
  symbolicNames ??= Parser.create('').parser.symbolicNames;
  return symbolicNames[type] ?? '';
};

/** The token names that have keyword items, for coverage checks. */
export const getMappedKeywordTokens = (): ReadonlySet<string> =>
  new Set(getKeywordEntries().map(({ token }) => token));

/**
 * The keyword and separator items for the tokens the grammar expects at the cursor. Command
 * names (tokens that would start a command) are left to the command suggestions.
 */
export const keywordsAt = ({ expectedTokens, tokenStacks }: CursorLocation): KeywordItem[] => {
  const keywords: KeywordItem[] = [];

  for (const type of expectedTokens) {
    const stack = tokenStacks.get(type);
    if (stack?.startsCommand) {
      continue;
    }

    const token = tokenName(type);
    const command = stack?.rules.findLast((rule) => rule.endsWith('Command'));
    const entries = getKeywordEntries().filter((entry) => entry.token === token);
    const entry =
      entries.find(
        (candidate) => candidate.command !== undefined && candidate.command === command
      ) ?? entries.find((candidate) => candidate.command === undefined);

    for (const item of entry?.items ?? []) {
      keywords.push({ token, item });
    }
  }

  return keywords;
};
