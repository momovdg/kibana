/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLCallbacks } from '@kbn/esql-types';
// The package entry is loaded first: its modules have to be evaluated in the package's order.
import { suggest as currentSuggest } from '../../..';
import { createCallbacks } from '../../__tests__/scenarios';
import type { ISuggestionItem } from '../../commands/registry/types';
import { suggest } from './suggest';

const CURSOR = '▮';

const at = async (marked: string, callbacks: ESQLCallbacks = createCallbacks()) => {
  const offset = marked.includes(CURSOR) ? marked.indexOf(CURSOR) : marked.length;

  return suggest(marked.replace(CURSOR, ''), offset, callbacks);
};

const itemWith = (items: ISuggestionItem[], text: string): ISuggestionItem | undefined =>
  items.find((item) => item.text === text);

describe('present (v2)', () => {
  describe('the text an item replaces', () => {
    it('is nothing where no word is typed', async () => {
      const items = await at('FROM a | KEEP ');

      expect(itemWith(items, 'keywordField')?.rangeToReplace).toEqual({ start: 14, end: 14 });
    });

    it('is the word being typed', async () => {
      const items = await at('FROM a | KEEP keyw');

      expect(itemWith(items, 'keywordField')?.rangeToReplace).toEqual({ start: 14, end: 18 });
    });

    it('is the word for what follows a word that is whole, matched by the word', async () => {
      const item = itemWith(await at('FROM a | KEEP keywordField'), 'keywordField | ');

      expect(item).toMatchObject({
        rangeToReplace: { start: 14, end: 26 },
        filterText: 'keywordField',
      });
    });

    it('is the space before the cursor for a separator', async () => {
      const afterSpace = itemWith(await at('FROM a | KEEP keywordField '), ', ');

      expect(afterSpace?.rangeToReplace).toEqual({ start: 26, end: 27 });
    });

    it('is the first word too for a keyword of several words', async () => {
      const item = itemWith(await at('FROM a | SORT keywordField NULLS F'), 'NULLS FIRST');

      expect(item?.rangeToReplace).toEqual({ start: 27, end: 34 });
    });

    it('is what is typed inside quotes, the quotes too for an item that brings its own', async () => {
      const bare = itemWith(await at('SET unmapped_fields = "N'), 'NULLIFY');
      const quoted = itemWith(
        await at('FROM a | COMPLETION "p" WITH { "inference_id": "inf'),
        '"inference_1"'
      );

      expect(bare?.rangeToReplace).toEqual({ start: 23, end: 24 });
      expect(quoted?.rangeToReplace).toEqual({ start: 47, end: 52 });
    });

    it('is the whole query where a query starts over', async () => {
      const item = itemWith(await at('▮FROM a | LIMIT 1'), 'FROM ');

      expect(item?.rangeToReplace).toEqual({ start: 0, end: 16 });
    });

    it('is not the query for a header statement, which comes before it', async () => {
      const item = itemWith(await at('▮FROM a | LIMIT 1'), 'SET ');

      expect(item).toBeDefined();
      expect(item?.rangeToReplace).toEqual({ start: 0, end: 0 });
    });
  });

  describe('the order of the items', () => {
    const labelsAt = async (query: string): Promise<string[]> =>
      (await at(query)).map(({ label }) => label);

    it('is the order the editor shows: every item has its place', async () => {
      const items = await at('FROM a | SORT keywordField ');

      expect(items.map(({ sortText }) => sortText)).toEqual(
        items.map((_, index) => index.toString().padStart(4, '0'))
      );
    });

    it('puts the keywords of the command before its end, and the columns before the functions', async () => {
      const afterColumn = await labelsAt('FROM a | SORT keywordField ');
      const start = await labelsAt('FROM a | EVAL ');

      expect(afterColumn.indexOf('ASC')).toBeLessThan(afterColumn.indexOf('|'));
      expect(start.indexOf('keywordField')).toBeLessThan(start.indexOf('ABS'));
    });

    it.each([
      'FROM a | STATS ',
      'FROM a | STATS AVG(doubleField) BY ',
      'FROM a | WHERE ',
      'FROM a | EVAL col0 = ',
    ])('is the order of the current flow at the end of %j', async (query) => {
      const current = await currentSuggest(query, query.length, createCallbacks());

      expect(await labelsAt(query)).toEqual(current.map(({ label }) => label));
    });

    it('lists a column the query shares with the index of a join first, and says so', async () => {
      const [first] = await at('FROM index | LOOKUP JOIN join_index ON ');

      expect(first.detail).toContain('(common field)');
    });
  });

  it('offers no new line on a line that has nothing on it yet', async () => {
    const sameLine = await at('FROM a | LIMIT 10 ');
    const emptyLine = await at('FROM a\n  ');

    expect(sameLine.map(({ text }) => text)).toContain('\n');
    expect(emptyLine.map(({ text }) => text)).not.toContain('\n');
  });

  describe('controls', () => {
    const callbacks = createCallbacks({ supportsControls: true });

    it('offers only the controls right after the character that starts one', async () => {
      const items = await at('FROM a | WHERE keywordField == ?', callbacks);

      expect(items.map(({ label }) => label)).toEqual(['Create control']);
    });

    it('offers nothing there when the editor has no controls', async () => {
      expect(await at('FROM a | WHERE keywordField == ?', createCallbacks())).toEqual([]);
    });
  });

  describe('where a query starts', () => {
    it('offers the commands a query starts with and queries that are ready to run', async () => {
      const current = await currentSuggest('', 0, createCallbacks());
      const labels = (await at('')).map(({ label }) => label);

      expect(labels).toEqual(current.map(({ label }) => label));
    });
  });
});
