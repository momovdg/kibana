/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Parser } from '@elastic/esql';
import { locateCursor } from '../../language/shared/cursor_location/cursor_location';
import { onSuggestion, withSuggestion } from './enrich/util';
import {
  byCompleteItem,
  joinOnCompleteItem,
  onCompleteItem,
  whereCompleteItem,
  withCompleteItem,
} from './complete_items';
import {
  EXPRESSION_ENGINE_TOKENS,
  IGNORED_TOKENS,
  getMappedKeywordTokens,
  keywordsAt,
} from './keyword_items';

const keywordsAtEnd = (text: string) => keywordsAt(locateCursor(text, text.length));

const labels = (text: string) =>
  keywordsAtEnd(text)
    .map(({ item }) => item.label)
    .sort();

const NEW_LINE_AND_PIPE = ['New line ⏎', '|'];

describe('keywordsAt', () => {
  it.each([
    [' FROM a | ENRICH pol  ', ['ON', 'WITH', ...NEW_LINE_AND_PIPE]],
    [' FROM a | ENRICH pol ON x  ', ['WITH', ...NEW_LINE_AND_PIPE]],
    [' FROM a | SORT b  ', ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', ',', ...NEW_LINE_AND_PIPE]],
    [' FROM a | SORT b NULLS  ', ['FIRST', 'LAST']],
    [' FROM a | RENAME x  ', ['=', 'AS']],
    [' FROM a | STATS c = COUNT(*)  ', ['BY', 'WHERE', ',', ...NEW_LINE_AND_PIPE]],
    [' FROM a  ', ['METADATA', ',', ...NEW_LINE_AND_PIPE]],
    [' FROM a | LIMIT 10  ', ['BY', ...NEW_LINE_AND_PIPE]],
    [' FROM a | FUSE  ', ['GROUP BY', 'KEY BY', 'SCORE BY', 'WITH', ...NEW_LINE_AND_PIPE]],
    [' FROM a | MMR ON x  ', ['LIMIT']],
    ['SHOW ', ['INFO']],
  ])('at %j returns %j', (text, expected) => {
    expect(labels(text)).toEqual([...expected].sort());
  });

  it('offers no command names', () => {
    expect(keywordsAtEnd(' FROM a | ')).toEqual([]);
    expect(keywordsAtEnd(' FROM a | FORK (')).toEqual([]);
  });

  it('offers no operators after an expression', () => {
    const tokens = keywordsAtEnd(' FROM a | WHERE b  ').map(({ token }) => token);

    expect(tokens.filter((token) => EXPRESSION_ENGINE_TOKENS.has(token))).toEqual([]);
  });

  it("uses the command's own item where it differs from the default", () => {
    const itemOf = (text: string, token: string) =>
      keywordsAtEnd(text).find((keyword) => keyword.token === token)?.item;

    expect(itemOf(' FROM a | ENRICH pol  ', 'ON')).toBe(onSuggestion);
    expect(itemOf(' FROM a | ENRICH pol  ', 'WITH')).toBe(withSuggestion);
    expect(itemOf(' FROM a | LOOKUP JOIN b  ', 'ON')).toBe(joinOnCompleteItem);
    expect(itemOf(' FROM a | CHANGE_POINT x  ', 'ON')).toBe(onCompleteItem);
    expect(itemOf(' FROM a | FUSE  ', 'WITH')).toBe(withCompleteItem);
    expect(itemOf(' FROM a | STATS c = COUNT(*)  ', 'BY')).toBe(byCompleteItem);
    expect(itemOf(' FROM a | INLINE STATS c = COUNT(*)  ', 'WHERE')).toBe(whereCompleteItem);
  });

  it('scopes keywords to the command inside a FORK branch', () => {
    expect(labels(' FROM a | FORK (SORT b  ')).toEqual(
      expect.arrayContaining(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST'])
    );
  });

  it('returns the keywords expected before the word being typed', () => {
    expect(labels(' FROM a | SORT b NU')).toEqual(labels(' FROM a | SORT b  '));
  });
});

describe('keyword table', () => {
  const { symbolicNames } = Parser.create('').parser;
  const vocabulary = new Set([...symbolicNames.filter(Boolean), 'EOF']);

  it('names only tokens of the grammar', () => {
    const tableTokens = [
      ...getMappedKeywordTokens(),
      ...EXPRESSION_ENGINE_TOKENS,
      ...IGNORED_TOKENS,
    ];

    expect(tableTokens.filter((token) => !vocabulary.has(token))).toEqual([]);
  });

  it('maps no dev-only token', () => {
    expect([...getMappedKeywordTokens()].filter((token) => token.startsWith('DEV_'))).toEqual([]);
  });

  it('does not map a token both as a keyword and as an expression token', () => {
    // Except FORK's `(`, which opens a branch.
    expect(
      [...getMappedKeywordTokens()].filter((token) => EXPRESSION_ENGINE_TOKENS.has(token))
    ).toEqual(['LP']);
  });
});
