/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { mockContext } from '../../../__tests__/commands/context_fixtures';
import { getFieldNamesByType, suggest } from '../../../__tests__/commands/autocomplete';
import { Location } from '../types';
import { createGenericAutocomplete } from './generic_autocomplete';
import { getCommandAutocomplete } from './command_autocomplete';
import { columns, merged, newName, none } from './providers';
import type { CommandAutocompleteSpec } from './types';

const texts = async (query: string, commandName: string, spec: CommandAutocompleteSpec) =>
  (
    await suggest(
      query,
      mockContext,
      commandName,
      undefined,
      createGenericAutocomplete(() => spec)
    )
  )
    .map(({ text }) => text)
    .sort();

const fieldNames = getFieldNamesByType('any');

describe('generic autocomplete', () => {
  describe('slots and keywords', () => {
    const renameSpec: CommandAutocompleteSpec = {
      slots: [
        { rule: 'qualifiedNamePattern', parent: 'renameClause', after: ['AS'], provide: none() },
        {
          rule: 'qualifiedNamePattern',
          parent: 'renameClause',
          after: ['ASSIGN'],
          provide: columns(),
        },
        {
          rule: 'qualifiedNamePattern',
          parent: 'renameClause',
          provide: merged(columns(), newName()),
        },
      ],
    };

    it('fills each slot from its provider', async () => {
      expect(await texts('from a | rename ', 'rename', renameSpec)).toEqual(
        [...fieldNames, ' = '].sort()
      );
      expect(await texts('from a | rename keywordField = ', 'rename', renameSpec)).toEqual(
        [...fieldNames].sort()
      );
      expect(await texts('from a | rename keywordField AS ', 'rename', renameSpec)).toEqual([]);
    });

    it('offers the keywords the grammar expects', async () => {
      // While a word is typed, keywords are not filtered by the readings of the name.
      expect(await texts('from a | rename keywordField A', 'rename', renameSpec)).toEqual([
        '= ',
        'AS ',
      ]);
    });

    it('lets the command narrow the keywords by token name', async () => {
      const spec: CommandAutocompleteSpec = {
        ...renameSpec,
        keywords: (keywords) => keywords.filter(({ token }) => token !== 'ASSIGN'),
      };

      expect(await texts('from a | rename keywordField ', 'rename', spec)).toEqual(['AS ']);
    });

    it('offers the same items after a comma with and without a space', async () => {
      expect(await texts('from a | keep keywordField,', 'keep', {})).toEqual(
        await texts('from a | keep keywordField, ', 'keep', {})
      );
    });

    it('removes duplicate items', async () => {
      const spec: CommandAutocompleteSpec = {
        slots: [{ rule: 'qualifiedNamePattern', provide: merged(columns(), columns()) }],
      };

      expect(await texts('from a | keep ', 'keep', spec)).toEqual([...fieldNames].sort());
    });
  });

  describe('nothing fits', () => {
    it('inside a comment', async () => {
      expect(await texts('from a | keep keywordField /* c', 'keep', {})).toEqual([]);
    });

    it('after characters the lexer dropped', async () => {
      expect(await texts('from a | enrich _any: ', 'enrich', {})).toEqual([]);
    });
  });

  describe('spacing', () => {
    const sortSpec: CommandAutocompleteSpec = { expression: { location: Location.SORT } };

    it('adds a leading space to keywords and the pipe right after a value', async () => {
      const result = await texts('from a | sort (keywordField)', 'sort', sortSpec);

      expect(result).toEqual(
        expect.arrayContaining([' ASC', ' DESC', ' NULLS FIRST', ' NULLS LAST', ' | ', ', ', '\n'])
      );
    });

    it('adds one after a quoted name, whatever token the lexer mode gives it', async () => {
      expect(await texts('from a | keep `keywordField`', 'keep', {})).toEqual(
        [' | ', ', ', '\n'].sort()
      );
    });

    it('adds none after whitespace', async () => {
      const result = await texts('from a | sort keywordField ', 'sort', sortSpec);

      expect(result).toEqual(expect.arrayContaining(['ASC', 'DESC', '| ', ', ', '\n']));
      expect(result).not.toContain(' ASC');
    });
  });

  describe('follow-ups after a complete word', () => {
    const keepSpec: CommandAutocompleteSpec = {
      slots: [{ rule: 'qualifiedNamePattern', followUps: true, provide: columns() }],
    };

    it('offers what follows an existing column, keeping it', async () => {
      expect(await texts('from a | keep keywordField', 'keep', keepSpec)).toEqual([
        '\n',
        'keywordField | ',
        'keywordField, ',
      ]);
    });

    it('offers the columns while the word is not an existing column', async () => {
      expect(await texts('from a | keep keyw', 'keep', keepSpec)).toEqual([...fieldNames].sort());
    });

    it('offers no follow-ups for a slot that does not opt in', async () => {
      expect(await texts('from a | keep keywordField', 'keep', {})).toEqual([...fieldNames].sort());
    });

    const sortSpec: CommandAutocompleteSpec = {
      keywordFollowUps: ['ASC', 'DESC', 'FIRST', 'LAST'],
      expression: { location: Location.SORT },
    };

    it('offers only what follows a complete keyword that opts in', async () => {
      expect(await texts('from a | sort keywordField asc', 'sort', sortSpec)).toEqual([
        '\n',
        'asc NULLS FIRST',
        'asc NULLS LAST',
        'asc | ',
        'asc, ',
      ]);
      expect(await texts('from a | sort keywordField NULLS last', 'sort', sortSpec)).toEqual([
        '\n',
        'last | ',
        'last, ',
      ]);
    });

    it('offers the keywords before the word while it is not complete', async () => {
      expect(await texts('from a | sort keywordField as', 'sort', sortSpec)).toEqual(
        expect.arrayContaining(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST'])
      );
    });
  });

  describe('default providers', () => {
    it('suggests the enrich modes for a word starting with _', async () => {
      expect(await texts('from a | enrich _', 'enrich', {})).toEqual([
        '_any:$0',
        '_coordinator:$0',
        '_remote:$0',
      ]);
    });

    it('keeps the range a provider sets, after an enrich mode', async () => {
      const query = 'from a | enrich _any:';
      const suggestions = await suggest(
        query,
        mockContext,
        'enrich',
        undefined,
        createGenericAutocomplete(() => ({}))
      );

      expect(suggestions.length).toBeGreaterThan(0);
      for (const { rangeToReplace } of suggestions) {
        expect(rangeToReplace).toEqual({ start: query.length, end: query.length });
      }
    });
  });
});

describe('getCommandAutocomplete', () => {
  it("returns a command's own autocomplete", () => {
    expect(getCommandAutocomplete('keep')).toBeDefined();
  });

  it('returns nothing for an unknown command', () => {
    expect(getCommandAutocomplete('not_a_command')).toBeUndefined();
  });
});
