/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { mockContext, getMockCallbacks } from '../../../__tests__/commands/context_fixtures';
import { genericAutocomplete as autocomplete } from '../generic_autocomplete/command_autocomplete';
import { expectSuggestions, getFieldNamesByType } from '../../../__tests__/commands/autocomplete';
import type { ICommandCallbacks } from '../types';
import { ESQL_STRING_TYPES } from '../../definitions/types';

const grokExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'grok',
    mockCallbacks,
    autocomplete
  );
};

describe('GROK Autocomplete', () => {
  let mockCallbacks: ICommandCallbacks;
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mocks before each test to ensure isolation
    mockCallbacks = {
      getByType: jest.fn(),
    };

    const expectedFields = getFieldNamesByType(ESQL_STRING_TYPES);
    (mockCallbacks.getByType as jest.Mock).mockResolvedValue(
      expectedFields.map((name) => ({ label: name, text: name }))
    );
  });

  it('suggests fields after GROK', async () => {
    await grokExpectSuggestions(
      'from a | grok ',
      getFieldNamesByType(ESQL_STRING_TYPES),
      mockCallbacks
    );
    await grokExpectSuggestions(
      'from a | grok key',
      getFieldNamesByType(ESQL_STRING_TYPES),
      mockCallbacks
    );
  });

  const constantPattern = '"%{WORD:firstWord}"';
  it('suggests a pattern after a field name', async () => {
    await grokExpectSuggestions(
      'from a | grok keywordField ',
      [constantPattern + ' '],
      mockCallbacks
    );
  });

  it('suggests pipe or comma after multiple patterns', async () => {
    await grokExpectSuggestions(
      'from a | grok keywordField "%{IP:ip}", "%{WORD:method}" ',
      ['| ', ', ', '\n'],
      mockCallbacks
    );
  });

  describe('from the grammar roles', () => {
    it('suggests only string columns', async () => {
      await grokExpectSuggestions(
        'from a | grok ',
        getFieldNamesByType(ESQL_STRING_TYPES),
        getMockCallbacks()
      );
    });

    it('suggests a next pattern after a comma', async () => {
      await grokExpectSuggestions(
        'from a | grok keywordField "%{IP:ip}", ',
        ['"%{WORD:nextWord}" '],
        mockCallbacks
      );
    });

    it('adds a space before the pipe right after a pattern', async () => {
      await grokExpectSuggestions(
        'from a | grok keywordField "%{IP:ip}"',
        [', ', ' | ', '\n'],
        mockCallbacks
      );
    });
  });
});
