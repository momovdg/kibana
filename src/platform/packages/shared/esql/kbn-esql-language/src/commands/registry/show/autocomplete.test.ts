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

const sampleExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'sample',
    mockCallbacks,
    autocomplete
  );
};

describe('SAMPLE Autocomplete', () => {
  it('suggests INFO', async () => {
    await sampleExpectSuggestions('SHOW /', ['INFO']);
  });

  it('suggests pipe after INFO', async () => {
    await sampleExpectSuggestions('SHOW INFO ', ['| ', '\n']);
    await sampleExpectSuggestions('SHOW INFO\t ', ['| ', '\n']);
    await sampleExpectSuggestions('SHOW info ', ['| ', '\n']);
  });

  it('offers what follows INFO typed in full, keeping it', async () => {
    await sampleExpectSuggestions('SHOW info', ['info | ', 'info\n']);
  });

  it('suggests nothing after a random word', async () => {
    await sampleExpectSuggestions('SHOW lolz ', []);
    await sampleExpectSuggestions('SHOW inof ', []);
  });
});
