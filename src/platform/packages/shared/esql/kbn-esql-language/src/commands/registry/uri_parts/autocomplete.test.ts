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

const uriPartsExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'uri_parts',
    mockCallbacks,
    autocomplete
  );
};

describe('URI_PARTS > autocomplete', () => {
  let mockCallbacks: ICommandCallbacks;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCallbacks = getMockCallbacks();
    mockCallbacks.getSuggestedUserDefinedColumnName = jest.fn(() => 'col0');

    const expectedFields = getFieldNamesByType(ESQL_STRING_TYPES);
    mockFieldsWithTypes(mockCallbacks, expectedFields);
  });

  it('suggests target field after command keyword', async () => {
    await uriPartsExpectSuggestions('FROM index | URI_PARTS ', ['col0 = '], mockCallbacks);
  });

  it('suggests assignment operator after target field', async () => {
    await uriPartsExpectSuggestions('FROM index | URI_PARTS prefix ', ['= '], mockCallbacks);
  });

  it('suggests string fields after assignment operator', async () => {
    await uriPartsExpectSuggestions(
      'FROM index | URI_PARTS prefix = ',
      getFieldNamesByType(ESQL_STRING_TYPES),
      mockCallbacks
    );
  });

  it('suggests pipe after complete command', async () => {
    await uriPartsExpectSuggestions(
      'FROM index | URI_PARTS prefix = url ',
      ['\n', '| '],
      mockCallbacks
    );
  });

  describe('from the grammar roles', () => {
    it('suggests only string columns', async () => {
      await uriPartsExpectSuggestions(
        'FROM index | URI_PARTS prefix = ',
        getFieldNamesByType(ESQL_STRING_TYPES),
        getMockCallbacks()
      );
    });

    it('suggests string columns while one is typed', async () => {
      await uriPartsExpectSuggestions(
        'FROM index | URI_PARTS prefix = key',
        getFieldNamesByType(ESQL_STRING_TYPES),
        getMockCallbacks()
      );
    });

    it('suggests what follows a complete column, keeping it', async () => {
      await uriPartsExpectSuggestions(
        'FROM index | URI_PARTS prefix = keywordField',
        ['keywordField\n', 'keywordField | '],
        mockCallbacks
      );
    });
  });
});
