/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { mockContext } from '../../../__tests__/commands/context_fixtures';
import { genericAutocomplete as autocomplete } from '../generic_autocomplete/command_autocomplete';
import { expectSuggestions, getFieldNamesByType } from '../../../__tests__/commands/autocomplete';
import type { ICommandCallbacks } from '../types';
import { setup } from '../../../language/autocomplete/__tests__/helpers';

const renameExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'rename',
    mockCallbacks,
    autocomplete
  );
};

describe('RENAME Autocomplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('suggests fields', async () => {
    const expectedSuggestions = [' = ', ...getFieldNamesByType('any')];
    await renameExpectSuggestions('from a | rename ', expectedSuggestions);
    await renameExpectSuggestions('from a | rename fie', expectedSuggestions);
    await renameExpectSuggestions('from a | rename field AS foo,', [...expectedSuggestions, ' = ']);
    await renameExpectSuggestions('from a | rename field = foo, ', expectedSuggestions);
    await renameExpectSuggestions('from a | rename field AS foo, fie', expectedSuggestions);
    await renameExpectSuggestions('from a | rename field = foo, fie', expectedSuggestions);
  });

  it('suggests AS after an existing field', async () => {
    await renameExpectSuggestions('from a | rename textField ', ['AS ']);
    await renameExpectSuggestions('from a | rename keywordField AS foo, textField ', ['AS ']);
    await renameExpectSuggestions('from a | rename keywordField as foo , textField ', ['AS ']);
  });

  it('suggests = after a field that does not exist', async () => {
    await renameExpectSuggestions('from a | rename field ', ['= ']);
    await renameExpectSuggestions('from a | rename keywordField AS foo, field ', ['= ']);
    await renameExpectSuggestions('from a | rename keywordField as foo , field ', ['= ']);
  });

  it('suggests nothing after AS', async () => {
    await renameExpectSuggestions('from a | rename keywordField AS ', []);
  });

  it('suggests fields after =', async () => {
    await renameExpectSuggestions('from a | rename field = ', getFieldNamesByType('any'));
  });

  it('suggests pipe and comma after complete expression', async () => {
    await renameExpectSuggestions('from a | rename field AS foo ', ['| ', ', ', '\n']);
  });

  describe('positions the grammar resolves', () => {
    it('reads a backtick-quoted name as one name', async () => {
      await renameExpectSuggestions('from a | rename `my field` ', ['= ']);
      // While a keyword is typed, all keywords stay; the editor filters them.
      await renameExpectSuggestions('from a | rename `my field` A', ['AS ', '= ']);
      await renameExpectSuggestions('from a | rename `any#Char$Field` ', ['AS ']);
    });

    it('suggests names while a backtick-quoted name is still open', async () => {
      await renameExpectSuggestions('from a | rename `my ', [' = ', ...getFieldNamesByType('any')]);
    });

    it('ignores comments between the parts of a clause', async () => {
      await renameExpectSuggestions('from a | rename textField /* note */ ', ['AS ']);
      await renameExpectSuggestions('from a | rename textField /* note */ AS /* note */ ', []);
    });

    it('suggests only columns right after =', async () => {
      await renameExpectSuggestions('from a | rename field =', getFieldNamesByType('any'));
    });

    it('handles clauses split across lines', async () => {
      await renameExpectSuggestions('from a\n| rename textField\n  ', ['AS ']);
      await renameExpectSuggestions('from a\n| rename textField\n  AS foo\n  ', ['| ', ', ', '\n']);
    });
  });

  describe('from the grammar roles', () => {
    it('suggests the keywords, not columns, while AS is typed in full', async () => {
      await renameExpectSuggestions('from a | rename textField AS', ['AS ', '= ']);
      await renameExpectSuggestions('from a | rename textField as', ['AS ', '= ']);
    });

    it('keeps the comma and pipe after a name only one reading allows', async () => {
      await renameExpectSuggestions('from a | rename x = unknownColumn ', ['| ', ', ', '\n']);
      await renameExpectSuggestions('from a | rename x AS keywordField ', ['| ', ', ', '\n']);
    });

    it('suggests nothing while the new name is typed after AS', async () => {
      await renameExpectSuggestions('from a | rename textField AS fo', []);
    });

    it('suggests only columns while the column after = is typed', async () => {
      await renameExpectSuggestions('from a | rename field = ke', getFieldNamesByType('any'));
    });

    it('suggests names while a dotted name is typed', async () => {
      await renameExpectSuggestions('from a | rename kubernetes.', [
        ' = ',
        ...getFieldNamesByType('any'),
      ]);
    });

    it('adds a space before AS right after a backtick-quoted column', async () => {
      await renameExpectSuggestions('from a | rename `textField`', [' AS ']);
    });

    it('is used by the full suggest()', async () => {
      const { assertSuggestions } = await setup();

      await assertSuggestions('FROM a | RENAME keywordField /', ['AS ']);
      await assertSuggestions('FROM a | RENAME keywordField AS /', []);
    });
  });
});
