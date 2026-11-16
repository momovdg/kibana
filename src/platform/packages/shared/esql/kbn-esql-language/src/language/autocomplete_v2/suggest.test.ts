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
    it.each(['FROM a // comment', 'FROM a | WHERE b == "text', 'FROM a | KEEP )', 'SHOW word '])(
      'suggests nothing at the end of %j',
      async (query) => {
        expect(await textsAt(query)).toEqual([]);
      }
    );
  });

  describe('a command that ends with a text in another language', () => {
    const callbacks = createCallbacks();

    it.each(['PROMQL ', 'PROMQL col0 = ', 'PROMQL step=5m rate(', 'PROMQL sum by ('])(
      'is served from the grammar of that language: %j gives what the current flow gives',
      async (query) => {
        const current = (await currentSuggest(query, query.length, callbacks)).map(
          ({ text }) => text
        );

        expect(current.length).toBeGreaterThan(0);
        expect((await textsAt(query, callbacks)).sort()).toEqual(current.sort());
      }
    );

    describe('the options written before its text', () => {
      const withSources = createCallbacks({
        timeseriesIndices: [
          { name: 'metrics', mode: 'Timeseries', aliases: [] },
          { name: 'logs-tsdb', mode: 'Timeseries', aliases: [] },
        ],
      });

      it('get their values from the signature: by the name of the option', async () => {
        expect(await textsAt('PROMQL step=', callbacks)).toEqual(['"${0:5m}"']);
        expect(await textsAt('PROMQL buckets = ', callbacks)).toEqual(['${0:100}']);
        expect(await textsAt('PROMQL start=', callbacks)).toEqual(
          expect.arrayContaining(['?_tstart', '?_tend'])
        );
      });

      it('get the entities their signature names, each listed once', async () => {
        expect((await textsAt('PROMQL index=', withSources)).sort()).toEqual([
          'logs-tsdb',
          'metrics',
        ]);
        expect(await textsAt('PROMQL index=metrics, ', withSources)).toEqual(['logs-tsdb']);
      });

      it('give way to the next option or the text once a value is written', async () => {
        const current = (await currentSuggest('PROMQL step=5m ', 15, callbacks)).map(
          ({ text }) => text
        );

        expect((await textsAt('PROMQL step=5m ', callbacks)).sort()).toEqual(current.sort());
      });
    });

    it('offers the options that can still be named, also counting those after the cursor', async () => {
      const texts = await suggest('PROMQL index=a step=5m ', 'PROMQL index=a '.length, callbacks);

      expect(texts.map(({ text }) => text)).not.toContain('step = ');
      expect(texts.map(({ text }) => text)).toContain('scrape_interval = ');
    });

    it('says what each option is for', async () => {
      const step = (await suggest('PROMQL ', 7, callbacks)).find(({ label }) => label === 'step');

      expect(step?.detail).toBe('Query resolution step (e.g. 1m, 5m, 1h)');
    });

    it('offers the assignment after the name of an option', async () => {
      expect(await textsAt('PROMQL step ', callbacks)).toEqual(['= ']);
    });

    it('offers only the end of the command once the brackets around the text are closed', async () => {
      expect((await textsAt('PROMQL col0 = (rate(a[5m]))', callbacks)).sort()).toEqual([
        '\n',
        '| ',
      ]);
    });

    it('is left once its end is written', async () => {
      expect(await textsAt('PROMQL rate(a[5m]) | ', callbacks)).toContain('WHERE ');
    });
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

    it('offers no command inside itself where Elasticsearch rejects that', async () => {
      const texts = await textsAt('FROM a | FORK (', license('platinum'));

      expect(texts).toContain('WHERE ');
      expect(texts).not.toContain('FORK ');
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

    describe('a keyword of several words', () => {
      it.each(['FROM a | SORT 1 nulls', 'FROM a | SORT 1 NULLS ', 'FROM a | SORT 1 NULLS F'])(
        'is still being typed at the end of %j, so what its start offers is offered',
        async (query) => {
          expect((await textsAt(query)).sort()).toEqual((await textsAt('FROM a | SORT 1 ')).sort());
        }
      );

      it('is not the name of a command with the keyword that follows it', async () => {
        expect(await textsAt('SHOW ')).toEqual(['INFO']);
      });
    });

    it('offers a clause that may be used once only while it is not written', async () => {
      const texts = await textsAt('FROM a | FUSE SCORE BY x ');

      expect(texts).toEqual(expect.arrayContaining(['KEY BY ', 'GROUP BY ']));
      expect(texts).not.toContain('SCORE BY ');
    });

    it('opens a branch with its brackets, and a subquery with the commands it can start with', async () => {
      expect(await textsAt('FROM a | FORK ')).toEqual(['($0)']);
      expect(await textsAt('FROM a | WHERE b IN ')).toEqual(expect.arrayContaining(['(FROM $0)']));
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
      it('offers only what ends the statement after a whole value, also when nothing does', async () => {
        expect(await textsAt('SET project_routing = true')).toEqual([';\n']);
        expect(await suggest('SET project_routing = 123;', 25)).toEqual([]);
      });

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

  describe('what the editor adds', () => {
    const withBrowser = createCallbacks({ supportsResourceBrowser: true });

    // The browser is an action: its item inserts no text.
    const hasAction = async (query: string, callbacks: ESQLCallbacks): Promise<boolean> =>
      (await textsAt(query, callbacks)).includes('');

    it('offers the browser of data sources where a source starts, when the editor has one', async () => {
      expect(await hasAction('FROM ', withBrowser)).toBe(true);
      expect(await hasAction('FROM a, ', withBrowser)).toBe(true);
      expect(await hasAction('FROM ', createCallbacks({}))).toBe(false);
    });

    it('does not offer the browser inside a subquery or while a name is typed', async () => {
      expect(await hasAction('FROM a, (FROM ', withBrowser)).toBe(false);
      expect(await hasAction('FROM ind', withBrowser)).toBe(false);
    });

    it('offers ready-made queries after the sources, where the next command can start', async () => {
      const texts = await textsAt('FROM index ', createCallbacks({}));

      expect(texts.some((text) => text.startsWith('\n| '))).toBe(true);
      expect(
        (await textsAt('FROM index, ', createCallbacks({}))).some((text) => text.startsWith('\n| '))
      ).toBe(false);
    });

    it('offers no ready-made query after a metadata field', async () => {
      const texts = await textsAt('FROM index METADATA _id ', createCallbacks({}));

      expect(texts.some((text) => text.startsWith('\n| '))).toBe(false);
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

    it('offers the assignment after any name where nothing else can follow it', async () => {
      const callbacks = createCallbacks({
        columns: [{ name: 'taken', type: 'keyword', userDefined: false }],
      });

      expect(await textsAt('FROM names | RERANK taken ', callbacks)).toEqual(['= ']);
      expect(await textsAt('FROM names | RENAME taken ', callbacks)).toEqual(['AS ']);
    });

    it('offers the name the editor suggests for an assigned name, selected for renaming', async () => {
      expect(await textsAt('FROM x | USER_AGENT ')).toEqual(['${1:user_agent} = ']);
    });

    it('picks a name the query does not use yet', async () => {
      expect(await textsAt('FROM x | RENAME col0 = a, ')).toContain('col1 = ');
    });

    it('offers the name the editor suggests for the place, with the separator it needs', async () => {
      expect(await textsAt('FROM x | CHANGE_POINT a AS ')).toEqual(['changePointType, ']);
      expect(await textsAt('FROM x | CHANGE_POINT a AS t, ')).toEqual(['pValue']);
    });
  });

  describe('constants', () => {
    it('offers the values a constant can take', async () => {
      expect(await textsAt('FROM x | FUSE ')).toEqual(expect.arrayContaining(['linear ', 'rrf ']));
    });

    it('offers a ready-made string where the value has a known use', async () => {
      expect(await textsAt('FROM x | RERANK a = ')).toEqual(['"${0:Your search query}"']);
      expect(await textsAt('FROM x | COMPLETION ')).toContain('"${0:Your prompt to the LLM.}"');
      expect(await textsAt('FROM x | COMPLETION pro')).not.toContain(
        '"${0:Your prompt to the LLM.}"'
      );
    });

    it('offers the default of a string, selected so that typing replaces it', async () => {
      expect(await textsAt('FROM x | HIGHLIGHT prefix = ')).toEqual(['"${0:highlight_}"']);
    });

    it('offers the values the editor suggests where any value is valid', async () => {
      expect((await textsAt('FROM x | SAMPLE ')).sort()).toEqual(['.001 ', '.01 ', '.1 ']);
      expect(await textsAt('FROM x | GROK a ')).toEqual(['"%{WORD:firstWord}" ']);
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

    describe('a kind of entity whose names can be qualified', () => {
      it('offers the qualifiers when the word typed starts one, the cursor where the name goes', async () => {
        expect(await textsAt('FROM a | ENRICH _', callbacks)).toEqual([
          '_any:$0',
          '_coordinator:$0',
          '_remote:$0',
        ]);
        expect(await textsAt('FROM a | ENRICH _re', callbacks)).toEqual(['_remote:$0']);
      });

      it('offers the names where nothing is typed, and after a qualifier', async () => {
        expect(await textsAt('FROM a | ENRICH ', callbacks)).toEqual(['policy ', '`policy$` ']);
        expect(await textsAt('FROM a | ENRICH _any:', callbacks)).toContain('policy ');
      });

      it('offers nothing after a qualifier that is left without a name', async () => {
        expect(await textsAt('FROM a | ENRICH _any: ', callbacks)).toEqual([]);
      });
    });

    it('offers what the editor can do for the name being typed, a qualifier left out', async () => {
      const create = async (query: string) =>
        (await suggest(query, query.length, callbacks))
          .filter(({ command }) => command?.id === 'esql.lookup_index.create')
          .map(({ text }) => text);

      expect(await create('FROM a | LOOKUP JOIN ')).toEqual(['']);
      expect(await create('FROM a | LOOKUP JOIN fresh')).toEqual(['fresh']);
      expect(await create('FROM a | LOOKUP JOIN _coordinator:fresh')).toEqual(['fresh']);
      expect(await create('FROM a | LOOKUP JOIN join_ind')).toEqual(['join_ind']);
    });

    it('offers what follows a name in quotes that is whole, with the name as written', async () => {
      expect(await textsAt('FROM index, "my-index"', callbacks)).toEqual(
        expect.arrayContaining(['"my-index", ', '"my-index" | '])
      );
    });

    it('offers no separator once every item of a list is listed', async () => {
      const some = await textsAt('FROM a METADATA _index ', callbacks);
      const all = await textsAt(
        'FROM a METADATA _version, _id, _index, _source, _ignored, _index_mode, _score, _size, _slice, _name, _class ',
        callbacks
      );

      expect(some).toContain(', ');
      expect(all).toEqual(expect.arrayContaining(['| ']));
      expect(all).not.toContain(', ');
    });

    it('offers what follows a name that is whole, with the name', async () => {
      expect(await textsAt('FROM a | LOOKUP JOIN join_index', callbacks)).toEqual([
        'join_index ON ',
      ]);
    });

    it('offers nothing at a place Elasticsearch does not support yet', async () => {
      expect(await textsAt('FROM a | LOOKUP JOIN join_index ', callbacks)).toEqual(['ON ']);
    });

    describe('a name that can be an entity or a new name', () => {
      it('is followed by the assignment only, when it is no entity of the scope', async () => {
        expect(await textsAt('FROM a | ENRICH policy ON b WITH fresh ', callbacks)).toEqual(['= ']);
      });

      it('is not looked up when it is a parameter, so what follows a value stays', async () => {
        expect(await textsAt('FROM a | COMPLETION ? ', callbacks)).toContain('WITH { $0 }');
      });

      it('is followed by what follows an entity, when it is one', async () => {
        expect(await textsAt('FROM a | ENRICH policy ON b WITH otherField ', callbacks)).toEqual(
          expect.arrayContaining([', ', '| '])
        );
        expect(
          await textsAt('FROM a | ENRICH policy ON b WITH otherField ', callbacks)
        ).not.toContain('= ');
      });
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

    it('leaves out of a list the values that are already in it', async () => {
      const texts = await textsAt('FROM x | USER_AGENT a = b WITH { "properties": ["name", ');

      expect(texts.sort()).toEqual(['"device"', '"os"', '"version"']);
    });

    it('offers the output columns a key selects from, for the variant another key names', async () => {
      const city = await textsAt('FROM x | IP_LOCATION a = b WITH { "properties": [ ');
      const country = await textsAt(
        'FROM x | IP_LOCATION a = b WITH { "database_file": "GeoLite2-Country.mmdb", "properties": [ '
      );

      expect(city).toContain('"city_name"');
      expect(country).toContain('"country_name"');
      expect(country).not.toContain('"city_name"');
    });

    describe('where the map has to be opened', () => {
      it('is opened with its only parameter, the cursor at its value', async () => {
        expect(await textsAt('FROM x | COMPLETION "p" WITH ')).toEqual([
          '{ "inference_id": "$0" }',
        ]);
        expect(await textsAt('FROM x | MMR ON a LIMIT 1 WITH ')).toEqual([
          '{ "lambda": ${0:0.5} }',
        ]);
      });

      it('is opened empty when it has several parameters', async () => {
        expect(await textsAt('FROM x | USER_AGENT a = b WITH ')).toEqual(['{ $0 }']);
      });

      it('is opened with the parameter the editor names for it', async () => {
        expect(await textsAt('FROM x | DENSE_VECTOR a WITH ')).toEqual([
          '{ "inference_id": "$0" }',
        ]);
      });

      it('is not offered again for the value of a parameter', async () => {
        expect(await textsAt('FROM x | FUSE rrf WITH { "rank_constant": ')).not.toContain('{ $0 }');
      });
    });

    it('offers the values the editor has for a parameter of the map a name is given', async () => {
      expect(await textsAt('SET approximation = { "rows": ')).toEqual([
        '100000',
        '500000',
        '1000000',
      ]);
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

      it('offers no grouping function for a key, and only the operators a key takes', async () => {
        expect(await textsAt('FROM e | LIMIT 1 BY ', callbacks)).not.toContain('CATEGORIZE($0)');
        expect(await textsAt('FROM e | LIMIT 1 BY n ', callbacks)).not.toContain('IS NULL');
      });

      it('offers no column where the value is a constant', async () => {
        const texts = await textsAt('ROW a = ', callbacks);

        expect(texts).toContain('ABS($0)');
        expect(texts).not.toContain('n ');
      });
    });

    it('offers the columns of the entity another argument names, next to those of the query', async () => {
      const world = createCallbacks();
      const texts = await textsAt('FROM index | LOOKUP JOIN join_index ON ', world);

      expect(texts).toEqual(expect.arrayContaining(['keywordField ', 'joinIndexOnlyField ']));
      expect(await textsAt('FROM index | WHERE ', world)).not.toContain('joinIndexOnlyField ');
    });

    it('offers before a required argument no keyword that comes after it', async () => {
      const start = await textsAt('FROM e | DENSE_VECTOR ', callbacks);

      expect(start).not.toContain('WITH { $0 }');
      expect(start).not.toContain('| ');
      expect(await textsAt('FROM e | DENSE_VECTOR k ', callbacks)).toEqual(
        expect.arrayContaining(['WITH { $0 }', '| '])
      );
    });

    it('offers a lone * for every column where the role takes one, while no column is listed', async () => {
      expect(await textsAt('FROM e | HIGHLIGHT "q" ON ', callbacks)).toContain('*');
      expect(await textsAt('FROM e | HIGHLIGHT "q" ON k, ', callbacks)).not.toContain('*');
    });

    it('lets a command end only once it has the arguments Elasticsearch requires', async () => {
      expect(await textsAt('FROM e | COMPLETION "p" ', callbacks)).toEqual(['WITH { $0 }']);
      expect(
        await textsAt('FROM e | COMPLETION "p" WITH { "inference_id": "i" } ', callbacks)
      ).toContain('| ');
    });

    it('lets a command that needs an argument end only once it has one', async () => {
      const start = await textsAt('FROM e | STATS ', callbacks);

      expect(start).not.toContain('| ');
      expect(start).not.toContain('\n');
      expect(await textsAt('FROM e | STATS COUNT() ', callbacks)).toContain('| ');
    });

    it('offers the columns the items before define, where the command reads its own', async () => {
      expect(await textsAt('FROM e | EVAL a = n + 1, ', callbacks)).toContain('a ');
      expect(await textsAt('FROM e | EVAL a = n + 1, b = ROUND(', callbacks)).toContain('a');
      expect(await textsAt('FROM e | STATS a = COUNT(), b = AVG(', callbacks)).not.toContain('a');
    });

    it('takes a column on its own as unfinished where the items are computed', async () => {
      expect(await textsAt('FROM e | EVAL n ', callbacks)).not.toContain('| ');
      expect(await textsAt('FROM e | EVAL a = n ', callbacks)).toContain('| ');
      expect(await textsAt('FROM e | SORT n ', callbacks)).toContain('| ');
    });

    it('offers a new name also while a word is typed where an item starts', async () => {
      expect(await textsAt('FROM e | EVAL ab', callbacks)).toContain('col0 = ');
    });

    describe('the names another argument of the command defines', () => {
      const labelsAt = async (before: string, after: string): Promise<string[]> =>
        (await suggest(before + after, before.length, callbacks)).map(({ label }) => label);

      it('are offered where the role reads them, also when they are written after the cursor', async () => {
        expect(await labelsAt('FROM e | STATS AVG(', ') BY g = n')).toContain('g');
        expect(await labelsAt('FROM e | STATS AVG(', ' BY g = n')).toContain('g');
        expect(await labelsAt('FROM e | STATS COUNT() WHERE ', ' BY g = k')).toContain('g');
      });

      it('have the type of their value', async () => {
        expect(await labelsAt('FROM e | STATS AVG(', ') BY g = k')).not.toContain('g');
      });

      it('include a value on its own, named by its text', async () => {
        expect(await labelsAt('FROM e | STATS COUNT() WHERE ', ' BY ROUND(n)')).toContain(
          'ROUND(n)'
        );
      });

      it('stand in the place of the column of the same name', async () => {
        expect(await labelsAt('FROM e | STATS AVG(', ') BY n = k')).not.toContain('n');
      });

      it('are not offered in the argument that defines them, nor in another command', async () => {
        expect(await labelsAt('FROM e | STATS COUNT() BY g = k, h = ', '')).not.toContain('g');
        expect(
          await labelsAt('FROM e | STATS c = COUNT() WHERE ', ' | STATS SUM(c) BY g = k')
        ).not.toContain('g');
      });
    });

    describe('inside a function call', () => {
      it('offers no aggregation inside an aggregation, nor the functions around the cursor', async () => {
        const inAggregation = await textsAt('FROM e | STATS AVG(', callbacks);
        const inScalar = await textsAt('FROM e | STATS ROUND(', callbacks);

        expect(inAggregation).not.toContain('MAX($0)');
        expect(inAggregation).toContain('ROUND($0)');
        expect(inScalar).toContain('MAX($0)');
        expect(inScalar).not.toContain('ROUND($0)');
      });

      it('offers no grouping function inside a grouping function', async () => {
        const texts = await textsAt('FROM e | STATS COUNT() BY BUCKET(', callbacks);

        expect(texts.filter((text) => text.startsWith('CATEGORIZE('))).toEqual([]);
      });
    });

    it('offers a column once in a list where its role says so, unless it is part of an item', async () => {
      expect(await textsAt('FROM e | SORT k, ', callbacks)).not.toContain('k ');
      expect(await textsAt('FROM e | SORT n + 1, ', callbacks)).toContain('n ');
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
