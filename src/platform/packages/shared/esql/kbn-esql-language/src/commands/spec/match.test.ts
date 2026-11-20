/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { matchSpec } from './match';
import type { SpecToken } from './tokens';
import { Location } from '../registry/types';
import { keyword, listOf, optional, slot, type CommandSpec } from './types';

/** The tokens of a text, split at spaces: enough to say where each one starts and ends. */
const tokensOf = (text: string): SpecToken[] =>
  [...text.matchAll(/\S+/g)].map(({ 0: word, index = 0 }) => ({
    text: word,
    start: index,
    end: index + word.length,
  }));

const column = slot('column');
const spec: CommandSpec = [column];

describe('matchSpec', () => {
  it('expects the first slot where nothing is written', () => {
    expect(matchSpec(spec, [])).toEqual({
      expected: [{ kind: 'slot', slot: column, listed: [] }],
      isInvalid: false,
    });
  });

  it('expects the end of the command once every slot is written', () => {
    expect(matchSpec(spec, tokensOf('bytes'))).toEqual({
      expected: [{ kind: 'end' }],
      isInvalid: false,
    });
  });

  it('reads the tokens written against each other as one value', () => {
    const dotted: SpecToken[] = [
      { text: 'host', start: 0, end: 4 },
      { text: '.', start: 4, end: 5 },
      { text: 'name', start: 5, end: 9 },
    ];

    expect(matchSpec(spec, dotted).expected).toEqual([{ kind: 'end' }]);
  });

  it('offers nothing where more is written than the spec has', () => {
    expect(matchSpec(spec, tokensOf('bytes extension'))).toEqual({
      expected: [],
      isInvalid: true,
    });
  });

  describe('a list', () => {
    const columns = listOf(column);
    const list: CommandSpec = [columns];

    it('expects an item after a comma, with what is listed before it', () => {
      expect(matchSpec(list, tokensOf('bytes , extension ,')).expected).toEqual([
        { kind: 'slot', slot: columns, listed: ['bytes', 'extension'] },
      ]);
    });

    it('expects the comma or the end of the command after an item', () => {
      expect(matchSpec(list, tokensOf('bytes , extension')).expected).toEqual([
        { kind: 'separator' },
        { kind: 'end' },
      ]);
    });

    it('offers nothing where an item is missing between two commas', () => {
      expect(matchSpec(list, tokensOf('bytes , ,')).isInvalid).toBe(true);
    });
  });

  describe('a part that may be left out', () => {
    const constant = slot('constant');
    const expressions = listOf(slot('expression', { functions: Location.SORT }));
    const withOptional: CommandSpec = [constant, optional(keyword('BY'), expressions)];

    it('expects its keyword or the end of the command where it can start', () => {
      expect(matchSpec(withOptional, tokensOf('10')).expected).toEqual([
        { kind: 'keyword', text: 'BY' },
        { kind: 'end' },
      ]);
    });

    it('reads its keyword in any case', () => {
      expect(matchSpec(withOptional, tokensOf('10 by')).expected).toEqual([
        { kind: 'slot', slot: expressions, listed: [], after: 'BY' },
      ]);
    });

    it('leaves the rest of the command to an expression', () => {
      expect(matchSpec(withOptional, tokensOf('10 BY bytes + 1 , extension')).expected).toEqual([
        { kind: 'slot', slot: expressions, listed: [], after: 'BY' },
      ]);
    });

    it('offers nothing where something else is written in its place', () => {
      expect(matchSpec(withOptional, tokensOf('10 20')).isInvalid).toBe(true);
    });

    it('offers nothing where its keyword is written in the place of a value', () => {
      expect(matchSpec(withOptional, tokensOf('by')).isInvalid).toBe(true);
    });
  });

  describe('a keyword', () => {
    const withKeyword: CommandSpec = [keyword('BY'), column];

    it('is expected where it has to be written', () => {
      expect(matchSpec(withKeyword, []).expected).toEqual([{ kind: 'keyword', text: 'BY' }]);
    });

    it('offers nothing where something else is written in its place', () => {
      expect(matchSpec(withKeyword, tokensOf('bytes')).isInvalid).toBe(true);
    });
  });
});
