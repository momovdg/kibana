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

const dropExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'drop',
    mockCallbacks,
    autocomplete
  );
};

describe('DROP Autocomplete', () => {
  const columnNames = Array.from(mockContext.columns.values()).map(({ name }) => name);

  it('suggests the columns', async () => {
    await dropExpectSuggestions('FROM a | DROP ', columnNames);
  });

  it('suggests the pipe, a comma and a new line after a column and a space', async () => {
    await dropExpectSuggestions('FROM a | DROP doubleField ', ['| ', ', ', '\n']);
  });

  it('offers what follows a complete column, keeping it', async () => {
    await dropExpectSuggestions('FROM a | DROP keywordField', [
      'keywordField\n',
      'keywordField | ',
      'keywordField, ',
    ]);
  });

  it('leaves out the columns already dropped, with or without a space after the comma', async () => {
    const others = columnNames.filter((name) => name !== 'keywordField');

    await dropExpectSuggestions('FROM a | DROP keywordField, ', others);
    await dropExpectSuggestions('FROM a | DROP keywordField,', others);
  });
});
