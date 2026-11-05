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

const mvExpandExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'mv_expand',
    mockCallbacks,
    autocomplete
  );
};

describe('MV_EXPAND Autocomplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('suggests columns', async () => {
    await mvExpandExpectSuggestions('from a | mv_expand ', getFieldNamesByType('any'));
  });

  it('works with field name prefixes', async () => {
    await mvExpandExpectSuggestions('from a | mv_expand key/', getFieldNamesByType('any'));
    await mvExpandExpectSuggestions('from a | mv_expand keywordField/', getFieldNamesByType('any'));
  });

  it('suggests pipe after column', async () => {
    await mvExpandExpectSuggestions('from a | mv_expand doubleField ', ['\n', '| ']);
  });

  it('offers what follows a complete column, keeping it', async () => {
    await mvExpandExpectSuggestions('from a | mv_expand keywordField', [
      'keywordField\n',
      'keywordField | ',
    ]);
  });
});
