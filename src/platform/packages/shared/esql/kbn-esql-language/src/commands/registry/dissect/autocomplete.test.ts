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
import {
  expectSuggestions,
  getFieldNamesByType,
  mockFieldsWithTypes,
} from '../../../__tests__/commands/autocomplete';
import type { ICommandCallbacks } from '../types';
import { ESQL_STRING_TYPES } from '../../definitions/types';

const dissectExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'dissect',
    mockCallbacks,
    autocomplete
  );
};

describe('DISSECT Autocomplete', () => {
  let mockCallbacks: ICommandCallbacks;
  beforeEach(() => {
    jest.clearAllMocks();

    mockCallbacks = getMockCallbacks();

    const expectedFields = getFieldNamesByType(ESQL_STRING_TYPES);
    mockFieldsWithTypes(mockCallbacks, expectedFields);
  });

  it('suggests fields after DISSECT', async () => {
    const contextWithoutControls = {
      ...mockContext,
      supportsControls: false,
    };

    const expectedStringFields = getFieldNamesByType(ESQL_STRING_TYPES);

    await dissectExpectSuggestions(
      'from a | DISSECT ',
      expectedStringFields,
      mockCallbacks,
      contextWithoutControls
    );

    await dissectExpectSuggestions(
      'from a | DISSECT key',
      expectedStringFields,
      mockCallbacks,
      contextWithoutControls
    );
  });

  const constantPattern = '"%{firstWord}" ';
  it('suggests a pattern after a field name', async () => {
    await dissectExpectSuggestions('from a | DISSECT keywordField ', [constantPattern]);
  });

  it('suggests an append separator or pipe after a pattern', async () => {
    await dissectExpectSuggestions(`from a | DISSECT keywordField ${constantPattern}`, [
      'APPEND_SEPARATOR = ',
      '| ',
      '\n',
    ]);
  });

  it('suggests append separators', async () => {
    await dissectExpectSuggestions(
      `from a | DISSECT keywordField ${constantPattern} append_separator = `,
      ['":" ', '";" ']
    );
  });

  it('suggests a pipe after an append separator', async () => {
    // The grammar takes a list of options, so a comma may follow too.
    await dissectExpectSuggestions(
      `from a | DISSECT keywordField ${constantPattern} append_separator = ":" `,
      ['| ', '\n', ', ']
    );
  });

  describe('from the grammar roles', () => {
    it('suggests only string columns', async () => {
      await dissectExpectSuggestions(
        'from a | DISSECT ',
        getFieldNamesByType(ESQL_STRING_TYPES),
        getMockCallbacks()
      );
    });

    it('suggests the option while it is typed', async () => {
      await dissectExpectSuggestions(`from a | DISSECT keywordField ${constantPattern}A`, [
        'APPEND_SEPARATOR = ',
        '| ',
        '\n',
      ]);
    });

    it('suggests = after the option name', async () => {
      await dissectExpectSuggestions(
        `from a | DISSECT keywordField ${constantPattern}APPEND_SEPARATOR `,
        ['= ']
      );
    });

    it('suggests the pattern right after a comment', async () => {
      await dissectExpectSuggestions('from a | DISSECT keywordField /* c */', [constantPattern]);
    });

    it('suggests the example pattern when a string is opened', async () => {
      await dissectExpectSuggestions('from a | DISSECT keywordField "', [constantPattern]);
    });
  });
});
