/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { locatePromql, type PromqlCursor } from './locate_promql';

const at = (query: string): PromqlCursor => locatePromql(query, query.length);

/** The rules that can start at the cursor, each with the rule it is reached through. */
const rules = ({ rules: expected }: PromqlCursor): string[] =>
  [...new Set(expected.map(({ rule, path }) => `${path.at(-1)}>${rule}`))].sort();

const texts = ({ followers }: PromqlCursor): string[] => followers.map(({ text }) => text);

const OPERAND = [
  'constant>number',
  'constant>string',
  'constant>timeValue',
  'seriesMatcher>identifier',
];

describe('locatePromql', () => {
  describe('where an operand starts', () => {
    it.each(['', 'rate(', 'sum by (job) (', 'sum(rate(a[5m])) + ', 'quantile_over_time(0, '])(
      'expects a name or a literal at the end of %j',
      (query) => {
        expect(rules(at(query))).toEqual(OPERAND);
      }
    );

    it('tells the arguments of a function by the bracket that can close them', () => {
      expect(texts(at('rate('))).toContain(')');
      expect(texts(at(''))).not.toContain(')');
    });

    it('expects the matching of two sides after an operator', () => {
      expect(texts(at('a + '))).toEqual(expect.arrayContaining(['on', 'ignoring']));
    });
  });

  describe('in a selector', () => {
    it.each([
      ['a{', ['label>labelName']],
      ['a{job="x", ', ['label>labelName']],
      ['{', ['label>labelName']],
      ['a{job=', ['label>labelValue']],
      ['a[', ['selector>duration']],
      ['a offset ', ['offset>timeValue']],
      ['a @ ', ['at>timeValue']],
    ])('expects at the end of %j: %j', (query, expected) => {
      expect(rules(at(query))).toEqual(expect.arrayContaining(expected));
    });

    it('offers the points in time the language names after @', () => {
      expect(texts(at('a @ '))).toEqual(expect.arrayContaining(['start()', 'end()']));
    });
  });

  describe('in a list of labels', () => {
    it.each(['sum by (', 'sum(rate(a[5m])) by (', 'sum without (a, ', 'a + on ('])(
      'expects a label at the end of %j',
      (query) => {
        expect(rules(at(query))).toEqual(['labelListItem>labelName']);
      }
    );
  });

  describe('after a whole expression', () => {
    it('expects what can go on with it, and lets the query end', () => {
      const cursor = at('rate(a[5m]) ');

      expect(rules(cursor)).toEqual([]);
      expect(texts(cursor)).toEqual(expect.arrayContaining(['by', 'without', '+', 'and', '==']));
      expect(cursor.canEnd).toBe(true);
    });

    it('expects what a selector can be followed by', () => {
      expect(texts(at('a{job="x"} '))).toEqual(expect.arrayContaining(['offset', '@', '[']));
    });

    it('does not let an unfinished query end', () => {
      expect(at('rate(').canEnd).toBe(false);
    });
  });

  describe('the word being typed', () => {
    it('is reported, with the place before it', () => {
      const cursor = at('rate(http');

      expect(cursor.word).toEqual({ text: 'http', start: 5 });
      expect(rules(cursor)).toEqual(OPERAND);
    });

    it('is none after a space', () => {
      expect(at('rate(a[5m]) ').word).toBeUndefined();
    });
  });

  it('reads only the text before the cursor', () => {
    expect(rules(locatePromql('rate(a{job="x"})', 7))).toEqual(['label>labelName']);
  });

  it('stays fast on a long query', () => {
    const query =
      'sum(avg(rate(bytes_counter{request="/elasticsearch", status=~"5.."}[5m]))) by (host, region) / on (host) group_left sum(rate(requests_total{env="prod"}[10m])) by (host) > ';
    const start = performance.now();

    for (let run = 0; run < 20; run++) {
      at(query);
    }

    // About 0.1 ms a call when measured; the bound only catches a walk that explodes.
    expect((performance.now() - start) / 20).toBeLessThan(20);
  });
});
