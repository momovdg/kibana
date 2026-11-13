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
import { esqlCommandRegistry } from '../../commands/registry';
import { suggest } from './suggest';

const textsAt = async (query: string, callbacks?: ESQLCallbacks): Promise<string[]> =>
  (await suggest(query, query.length, callbacks)).map(({ text }) => text);

const license = (level?: string): ESQLCallbacks => ({
  getLicense: async () => ({ hasAtLeast: (required) => required === level }),
});

const commandText = (name: string): string => `${name.toUpperCase()} `;

const licensed = esqlCommandRegistry
  .getAllCommands()
  .filter(({ metadata }) => metadata.license && !metadata.hidden && !metadata.type);
const timeSeriesOnly = esqlCommandRegistry
  .getAllCommands()
  .filter(({ metadata }) => metadata.requiresTimeseriesSource && !metadata.hidden);

describe('suggest (v2)', () => {
  describe('where nothing applies', () => {
    it.each(['FROM a // comment', 'FROM a | WHERE b == "text', 'FROM a | KEEP )'])(
      'suggests nothing at the end of %j',
      async (query) => {
        expect(await textsAt(query)).toEqual([]);
      }
    );
  });

  describe('command names', () => {
    it('offers the commands that can start a query', async () => {
      expect(await textsAt('')).toEqual(expect.arrayContaining(['FROM ', 'ROW ', 'SHOW ', 'TS ']));
    });

    it('offers after a pipe the same commands as the current flow', async () => {
      const callbacks = license('platinum');
      const current = (await currentSuggest('FROM a | ', 9, callbacks)).map(({ text }) => text);

      // The current flow leaves FORK out after a pipe only when a FORK is already there.
      expect((await textsAt('FROM a | ', callbacks)).sort()).toEqual(current.sort());
    });

    it('offers a command that starts in several ways once per way Kibana registered', async () => {
      const texts = await textsAt('FROM a | ');

      expect(texts.filter((text) => text.includes('JOIN'))).toEqual(['LOOKUP JOIN ']);
      expect(texts.filter((text) => text.startsWith('INLINE'))).toEqual(['INLINE STATS ']);
    });

    it('leaves out a command the grammar has and Kibana has not registered', async () => {
      expect(await textsAt('FROM a | ')).not.toContain('FILLNULL ');
    });

    it('offers no header command inside the pipeline', async () => {
      expect(await textsAt('FROM a | ')).not.toContain('SET ');
    });

    it('offers the commands of a branch where a branch starts', async () => {
      const texts = await textsAt('FROM a | FORK (');

      expect(texts).toEqual(expect.arrayContaining(['WHERE ', 'LIMIT ']));
      expect(texts).not.toContain('FROM ');
    });

    it('offers only the commands that can start a subquery inside one', async () => {
      expect((await textsAt('FROM a, (')).sort()).toEqual(
        esqlCommandRegistry
          .getAllCommands()
          .filter(({ metadata }) => metadata.subquerySource && !metadata.hidden)
          .map(({ name }) => commandText(name))
          .sort()
      );
    });
  });

  describe('gates', () => {
    it('has commands to check each gate with', () => {
      expect(licensed.length).toBeGreaterThan(0);
      expect(timeSeriesOnly.length).toBeGreaterThan(0);
    });

    it('offers a licensed command only when the license reaches its level', async () => {
      const [{ name, metadata }] = licensed;
      const level = metadata.license?.toLocaleLowerCase();

      expect(await textsAt('FROM a | ', license(level))).toContain(commandText(name));
      expect(await textsAt('FROM a | ', license('basic'))).not.toContain(commandText(name));
      expect(await textsAt('FROM a | ')).not.toContain(commandText(name));
    });

    it('offers a command that needs a time-series source only after one', async () => {
      const [{ name }] = timeSeriesOnly;

      expect(await textsAt('TS a | ')).toContain(commandText(name));
      expect(await textsAt('FROM a | ')).not.toContain(commandText(name));
    });

    it('does not offer a command after one of the commands it is hidden after', async () => {
      const hidden = esqlCommandRegistry
        .getAllCommands()
        .filter(({ metadata }) => metadata.hiddenAfterCommands?.length && !metadata.hidden);

      for (const { name, metadata } of hidden) {
        const [after] = metadata.hiddenAfterCommands ?? [];
        const isHeader = esqlCommandRegistry.getCommandByName(after)?.metadata.type === 'header';

        // A header command comes before the query; any other one comes before a pipe.
        if (isHeader) {
          expect(await textsAt('')).toContain(commandText(name));
          expect(await textsAt('LET a = (FROM b); ')).not.toContain(commandText(name));
        }
      }
    });
  });

  describe('keywords and the end of a command', () => {
    it('offers the keywords the grammar expects, the pipe and the next line', async () => {
      expect((await textsAt('FROM a | LIMIT 10 ')).sort()).toEqual(['\n', 'BY ', '| ']);
      expect((await textsAt('FROM a | CHANGE_POINT b ')).sort()).toEqual([
        '\n',
        'AS ',
        'BY ',
        'ON ',
        '| ',
      ]);
    });

    it('offers no end where the command cannot end', async () => {
      const texts = await textsAt('FROM a | RENAME b ');

      expect(texts).not.toContain('| ');
      expect(texts).not.toContain('\n');
    });

    it('offers the next line wherever the next command can start, also in a branch', async () => {
      expect(await textsAt('FROM a | FORK (LIMIT 10 ')).toEqual(
        expect.arrayContaining(['| ', '\n'])
      );
    });

    it('offers the separator of a list with a space after it', async () => {
      expect((await textsAt('FROM a | KEEP b ')).sort()).toEqual(['\n', ', ', '| ']);
    });

    describe('a keyword, by what the grammar allows right after it', () => {
      it('is offered alone when nothing has to follow it', async () => {
        const texts = await textsAt('FROM a | SORT 1 ');

        expect(texts).toEqual(expect.arrayContaining(['ASC', 'DESC']));
      });

      it('is offered with the keywords that have to follow it', async () => {
        const texts = await textsAt('FROM a | SORT 1 ');

        expect(texts).toEqual(expect.arrayContaining(['NULLS FIRST', 'NULLS LAST']));
        expect(texts).not.toContain('NULLS ');
      });

      it('is offered with the braces of the map that has to follow it', async () => {
        expect(await textsAt('FROM a | COMPLETION "p" ')).toContain('WITH { $0 }');
      });

      it('is offered with a space when anything else has to follow it', async () => {
        expect(await textsAt('FROM a | STATS c = COUNT() ')).toContain('BY ');
      });
    });

    it('offers each item once', async () => {
      const texts = await textsAt('FROM a | SORT 1 ');

      expect(new Set(texts).size).toBe(texts.length);
    });
  });

  describe('columns', () => {
    const world = (names: Record<string, string>) =>
      createCallbacks({
        columns: Object.entries(names).map(([name, type]) => ({ name, type, userDefined: false })),
      });
    const callbacks = world({ a: 'keyword', b: 'long', c: 'text' });

    it('offers the columns of the query before the cursor', async () => {
      expect((await textsAt('FROM x | KEEP ', callbacks)).sort()).toEqual(['a', 'b', 'c']);
    });

    it('offers only the columns of the types the argument accepts', async () => {
      expect((await textsAt('FROM x | DISSECT ', callbacks)).sort()).toEqual(['a ', 'c ']);
    });

    it('leaves out a column that is already listed where each is listed once', async () => {
      expect((await textsAt('FROM x | KEEP a, ', callbacks)).sort()).toEqual(['b', 'c']);
      // A word that is not yet a column: the list is filtered by the editor as it is typed.
      expect((await textsAt('FROM x | KEEP a, z', callbacks)).sort()).toEqual(['b', 'c']);
    });

    it('ends a column with a space unless a list separator can follow it', async () => {
      // KEEP takes a list: the separator is offered on the name itself.
      expect(await textsAt('FROM x | KEEP ', callbacks)).toContain('a');
      // MV_EXPAND takes one column: the cursor moves on.
      expect(await textsAt('FROM x | MV_EXPAND ', callbacks)).toContain('a ');
    });

    it('does not offer the columns again after a complete one', async () => {
      expect((await textsAt('FROM x | KEEP a ', callbacks)).sort()).toEqual(['\n', ', ', '| ']);
    });

    it('reads the columns a command before the cursor defines', async () => {
      expect(await textsAt('FROM x | EVAL d = 1 | KEEP ', callbacks)).toContain('d');
    });

    it('asks the editor for columns only where they are offered', async () => {
      const spied = { ...callbacks, getColumnsFor: jest.fn(callbacks.getColumnsFor) };

      await textsAt('FROM y | LIMIT 10 ', spied);
      expect(spied.getColumnsFor).not.toHaveBeenCalled();

      await textsAt('FROM y | KEEP ', spied);
      expect(spied.getColumnsFor).toHaveBeenCalled();
    });
  });

  describe('presentation', () => {
    it('offers the values the editor suggests where the language allows any', async () => {
      expect(await textsAt('FROM a | LIMIT ')).toEqual(['10 ', '100 ', '1000 ']);
    });

    it('offers the end of a header statement after its value, with the next line', async () => {
      expect(await textsAt('SET approximation = true ')).toEqual([';\n']);
    });

    it('does not offer the end of a statement that is already written', async () => {
      const query = 'SET approximation = true ';

      expect((await suggest(`${query};`, query.length)).map(({ text }) => text)).toEqual([]);
    });

    it('ends a value with the terminator its statement needs', async () => {
      expect(await textsAt('SET approximation = ')).toEqual(
        expect.arrayContaining(['true;', 'false;'])
      );
    });

    it('offers the values the editor suggests for the value of a name', async () => {
      expect(await textsAt('SET project_routing = ')).toEqual(
        expect.arrayContaining(['"_alias:*";', '"_alias:_origin";'])
      );
      // Inside the quotes the value comes without them, and without the terminator.
      expect(await textsAt('SET project_routing = "_al')).toEqual(
        expect.arrayContaining(['_alias:*', '_alias:_origin'])
      );
    });

    describe('a word that is already whole', () => {
      const callbacks = createCallbacks({
        columns: [{ name: 'host', type: 'keyword', userDefined: false }],
      });

      it('is offered with what can follow it, when it is a column that exists', async () => {
        expect((await textsAt('FROM w | SORT host', callbacks)).sort()).toEqual([
          '\n',
          'host ASC',
          'host DESC',
          'host NULLS FIRST',
          'host NULLS LAST',
          'host | ',
          'host, ',
        ]);
      });

      it('is offered with what can follow it, when it is a keyword typed in full', async () => {
        expect(await textsAt('FROM w | SORT host ASC', callbacks)).toEqual(
          expect.arrayContaining(['ASC NULLS FIRST', 'ASC, ', 'ASC | '])
        );
      });

      it('keeps the usual items while the word is not whole', async () => {
        expect(await textsAt('FROM w | SORT hos', callbacks)).toContain('host ');
      });

      it('keeps the usual items where the command cannot go on after it', async () => {
        // A filter is not finished by a column alone.
        expect(await textsAt('FROM w | WHERE host', callbacks)).toContain('host ');
      });

      it('gets the end of its statement when it is a value', async () => {
        expect(await textsAt('SET project_routing = "x"')).toEqual([';\n']);
      });
    });

    it('offers subqueries where a bracket can only open one, with the terminator they need', async () => {
      expect((await textsAt('LET s = ')).sort()).toEqual(['(FROM $0);', '(ROW $0);', '(TS $0);']);
    });

    it('offers a ready-made date histogram where a grouping starts', async () => {
      const texts = await textsAt('FROM a | STATS COUNT() BY ');

      expect(texts.some((text) => text.startsWith('BUCKET($0, '))).toBe(true);
      expect(await textsAt('FROM a | EVAL b = ')).not.toContain('BUCKET($0, 50, ?_tstart, ?_tend)');
    });
  });

  describe('the assignment after a name', () => {
    const callbacks = createCallbacks({
      columns: [{ name: 'existing', type: 'keyword', userDefined: false }],
    });

    it('is offered after a name the query does not have, and nothing that reads a column', async () => {
      expect(await textsAt('FROM n | RENAME fresh ', callbacks)).toEqual(['= ']);
    });

    it('is not offered after an existing column', async () => {
      expect(await textsAt('FROM n | RENAME existing ', callbacks)).toEqual(['AS ']);
    });

    it('is offered after a new name where an expression could also start', async () => {
      const texts = await textsAt('FROM n | EVAL fresh ', callbacks);

      expect(texts).toContain('= ');
      expect(texts).not.toContain('| ');
    });
  });

  describe('new names', () => {
    it('offers a name with its assignment where the grammar assigns it', async () => {
      expect(await textsAt('FROM x | RENAME ')).toContain('col0 = ');
    });

    it('offers nothing where any name can be typed', async () => {
      expect(await textsAt('FROM x | RENAME a AS ')).toEqual([]);
    });

    it('picks a name the query does not use yet', async () => {
      expect(await textsAt('FROM x | RENAME col0 = a, ')).toContain('col1 = ');
    });
  });

  describe('constants', () => {
    it('offers the values a constant can take', async () => {
      expect(await textsAt('FROM x | FUSE ')).toEqual(expect.arrayContaining(['linear ', 'rrf ']));
    });
  });

  describe('entities', () => {
    const callbacks = createCallbacks();

    it('offers the sources, without the hidden ones, and each only once', async () => {
      const sources = await textsAt('FROM ', callbacks);

      expect(sources).toEqual(expect.arrayContaining(['index', 'a_index']));
      expect(sources).not.toContain('.secret_index');
      expect(await textsAt('FROM index, ', callbacks)).not.toContain('index');
    });

    it('offers a subquery where one can stand for a source, and not inside a subquery', async () => {
      const texts = await textsAt('FROM ', callbacks);

      expect(texts).toEqual(expect.arrayContaining(['(FROM $0)', '(ROW $0)', '(TS $0)']));
      expect(await textsAt('FROM a, (FROM ', callbacks)).not.toContain('(FROM $0)');
    });

    it('offers only time-series sources where the signature says so', async () => {
      const sources = await textsAt('TS ', callbacks);

      expect(sources).toEqual(
        expect.arrayContaining(['timeseries_index', 'timeseries_index_alias_1'])
      );
      expect(sources).not.toContain('index');
    });

    it('offers an entity that stands alone with a space after it', async () => {
      expect(await textsAt('FROM a | ENRICH ', callbacks)).toEqual(['policy ', '`policy$` ']);
      expect(await textsAt('FROM a | LOOKUP JOIN ', callbacks)).toContain('join_index ');
    });

    it('offers the entities of the parent another argument names', async () => {
      expect(await textsAt('FROM a | ENRICH policy ON b WITH c = ', callbacks)).toEqual([
        'otherField',
        'yetAnotherField',
      ]);
      expect(await textsAt('FROM a | ENRICH unknown ON b WITH c = ', callbacks)).toEqual([]);
    });

    it('leaves out an entity that is already listed where each is listed once', async () => {
      const fields = await textsAt('FROM a METADATA _id, ', callbacks);

      expect(fields).toContain('_index');
      expect(fields).not.toContain('_id');
    });

    it('offers the entities of the scope', async () => {
      const serverless = createCallbacks({ isServerless: true });

      expect(await textsAt('FROM a METADATA ', callbacks)).not.toContain('_project._id');
      expect(await textsAt('FROM a METADATA ', serverless)).toContain('_project._id');
    });

    it('adds the only symbol that can follow a name', async () => {
      expect(await textsAt('SET ', callbacks)).toContain('unmapped_fields = ');
    });
  });

  describe('maps', () => {
    const callbacks = createCallbacks();
    const sorted = async (query: string) => (await textsAt(query, callbacks)).sort();

    it('offers the keys of the map', async () => {
      expect(await sorted('FROM a | DENSE_VECTOR b WITH { ')).toEqual([
        '"inference_id": "$0"',
        '"timeout": "$0"',
        '"type": "$0"',
      ]);
    });

    it('offers a key by the type of its value', async () => {
      expect(await sorted('FROM a | FUSE rrf WITH { ')).toEqual([
        '"rank_constant": ',
        '"weights": { $0 }',
      ]);
    });

    it('leaves out a key that is already used', async () => {
      expect(await sorted('FROM a | DENSE_VECTOR b WITH { "inference_id": "x", ')).toEqual([
        '"timeout": "$0"',
        '"type": "$0"',
      ]);
    });

    it('offers the values a key lists, also inside the open string', async () => {
      expect(await sorted('FROM a | DENSE_VECTOR b WITH { "type": ')).toEqual([
        '"image"',
        '"text"',
      ]);
      expect(await sorted('FROM a | DENSE_VECTOR b WITH { "type": "')).toEqual([
        '"image"',
        '"text"',
      ]);
    });

    it('offers the default of a key that lists no value', async () => {
      expect(await sorted('FROM a | DENSE_VECTOR b WITH { "timeout": "')).toEqual(['"30s"']);
      expect(await sorted('FROM a | FUSE rrf WITH { "rank_constant": ')).toEqual(['60']);
    });

    it('offers the entities a key names, for the task its signature says', async () => {
      expect(await sorted('FROM a | COMPLETION "p" WITH { "inference_id": "')).toEqual([
        '"inference_1"',
      ]);
      // The default world has no endpoint for reranking.
      expect(await sorted('FROM a | RERANK "q" ON b WITH { "inference_id": "')).toEqual([]);
    });

    it('offers nothing for a key the map does not have', async () => {
      expect(await sorted('FROM a | COMPLETION "p" WITH { "other": "')).toEqual([]);
    });

    it('offers nothing inside a map that is the value of a key', async () => {
      expect(await sorted('FROM a | FUSE linear WITH { "weights": { ')).toEqual([]);
    });

    describe('a key that applies only for some values of another argument', () => {
      it('follows the value that is written', async () => {
        expect(await sorted('FROM a | FUSE linear WITH { ')).toEqual([
          '"normalizer": "$0"',
          '"weights": { $0 }',
        ]);
      });

      it('follows the default of the argument when it is not written', async () => {
        expect(await sorted('FROM a | FUSE WITH { ')).toEqual([
          '"rank_constant": ',
          '"weights": { $0 }',
        ]);
      });
    });
  });

  describe('option names', () => {
    it('offers an option with its assignment', async () => {
      expect(await textsAt('FROM a | DISSECT b "%{c}" ')).toContain('APPEND_SEPARATOR = ');
    });
  });

  describe('a value that depends on a name', () => {
    it('takes the roles the named entity defines for its value', async () => {
      expect((await textsAt('SET approximation = ')).sort()).toEqual([
        'false;',
        'true;',
        '{ $0 };',
      ]);
      expect((await textsAt('SET approximation = { ')).sort()).toEqual([
        '"confidence_level": ',
        '"rows": ',
      ]);
    });

    it('offers nothing for a name that defines nothing', async () => {
      expect(await textsAt('SET unknown_setting = ')).toEqual([]);
    });
  });

  describe('expressions', () => {
    // The columns of a query are cached by its text: these tests read a source of their own.
    const callbacks = createCallbacks({
      columns: [
        { name: 'k', type: 'keyword', userDefined: false },
        { name: 'n', type: 'long', userDefined: false },
      ],
    });
    const currentTextsAt = async (query: string): Promise<string[]> =>
      (await currentSuggest(query, query.length, callbacks)).map(({ text }) => text);

    it('offers columns and functions where an expression starts', async () => {
      const texts = await textsAt('FROM e | WHERE ', callbacks);

      expect(texts).toEqual(expect.arrayContaining(['k ', 'n ', 'ABS($0)']));
    });

    it('offers the operators that fit what is written of the expression', async () => {
      const texts = await textsAt('FROM e | WHERE n ', callbacks);

      expect(texts).toEqual(expect.arrayContaining(['> $0', '+ $0']));
      expect(texts).not.toContain('LIKE $0');
    });

    it('lets the command go on only once the expression has the type its role asks for', async () => {
      expect(await textsAt('FROM e | WHERE n ', callbacks)).not.toContain('| ');
      expect(await textsAt('FROM e | WHERE n > 1 ', callbacks)).toEqual(
        expect.arrayContaining(['| ', 'AND $0'])
      );
    });

    it('offers the operands of the type an operator needs', async () => {
      const texts = await textsAt('FROM e | WHERE n > ', callbacks);

      expect(texts).toContain('n');
      expect(texts).not.toContain('k');
    });

    it('offers the arguments of a function by its signature', async () => {
      const texts = await textsAt('FROM e | EVAL a = TO_UPPER(', callbacks);

      expect(texts).toContain('k');
      expect(texts).not.toContain('n');
    });

    it('offers the expression once, whatever the cursor is nested in', async () => {
      const texts = await textsAt('FROM e | WHERE n > 1 AND ', callbacks);

      expect(texts.filter((text) => text === 'ABS($0)')).toHaveLength(1);
    });

    describe('by the mode of the role', () => {
      it('offers aggregations, and columns only as their arguments', async () => {
        const start = await textsAt('FROM e | STATS ', callbacks);

        expect(start).toContain('AVG($0)');
        expect(start).not.toContain('n ');
        expect(await textsAt('FROM e | STATS AVG(', callbacks)).toContain('n');
      });

      it('offers grouping functions in a grouping and not in a scalar expression', async () => {
        expect(await textsAt('FROM e | STATS AVG(n) BY ', callbacks)).toContain('CATEGORIZE($0)');
        expect(await textsAt('FROM e | EVAL a = ', callbacks)).not.toContain('CATEGORIZE($0)');
      });

      it('offers full-text functions in a filter, also the filter of an aggregation', async () => {
        expect(await textsAt('FROM e | WHERE ', callbacks)).toContain('MATCH($0)');
        expect(await textsAt('FROM e | STATS AVG(n) WHERE ', callbacks)).toContain('MATCH($0)');
        expect(await textsAt('FROM e | SORT ', callbacks)).not.toContain('MATCH($0)');
      });

      it('offers no column where the value is a constant', async () => {
        const texts = await textsAt('ROW a = ', callbacks);

        expect(texts).toContain('ABS($0)');
        expect(texts).not.toContain('n ');
      });
    });

    it.each([
      'FROM e | WHERE ',
      'FROM e | WHERE k',
      'FROM e | WHERE k ',
      'FROM e | WHERE n > ',
      'FROM e | WHERE n > 1 ',
      'FROM e | WHERE n > 1 AND ',
      'FROM e | WHERE (n ',
      'FROM e | WHERE k IS ',
      'FROM e | WHERE ABS(',
      'FROM e | WHERE n IN (',
      'FROM e | WHERE n::',
      'FROM e | EVAL a = ',
      'FROM e | EVAL a = n + ',
      'FROM e | EVAL a = ROUND(n, ',
    ])('offers at the end of %j what the current flow offers', async (query) => {
      expect((await textsAt(query, callbacks)).sort()).toEqual(
        (await currentTextsAt(query)).sort()
      );
    });
  });
});
