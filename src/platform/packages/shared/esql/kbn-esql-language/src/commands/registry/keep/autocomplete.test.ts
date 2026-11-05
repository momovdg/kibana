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
import { expectSuggestions } from '../../../__tests__/commands/autocomplete';
import type { ICommandCallbacks } from '../types';

const keepExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'keep',
    mockCallbacks,
    autocomplete
  );
};

describe('KEEP Autocomplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('suggests available fields after KEEP', async () => {
    const columns = mockContext.columns;

    await keepExpectSuggestions('FROM a | KEEP ', [
      ...Array.from(columns.values()).map((column) => column.name),
    ]);
  });

  it('suggests command and pipe after a field has been used in KEEP', async () => {
    await keepExpectSuggestions('FROM logs* | KEEP doubleField ', ['| ', ', ', '\n']);
  });

  describe('from the grammar', () => {
    const columnNames = Array.from(mockContext.columns.values()).map(({ name }) => name);

    it('offers what follows a complete column, keeping it', async () => {
      await keepExpectSuggestions('FROM a | KEEP keywordField', [
        'keywordField\n',
        'keywordField | ',
        'keywordField, ',
      ]);
    });

    it('leaves out the columns already kept, with or without a space after the comma', async () => {
      const others = columnNames.filter((name) => name !== 'keywordField');

      await keepExpectSuggestions('FROM a | KEEP keywordField, ', others);
      await keepExpectSuggestions('FROM a | KEEP keywordField,', others);
    });

    it('offers what follows a backtick-quoted column, with a leading space for the pipe', async () => {
      await keepExpectSuggestions('FROM a | KEEP `keywordField`', [' | ', ', ', '\n']);
    });
  });
});
