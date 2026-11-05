/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { mockContext } from '../../../__tests__/commands/context_fixtures';
import { expectSuggestions } from '../../../__tests__/commands/autocomplete';
import { genericAutocomplete } from '../generic_autocomplete/command_autocomplete';

const tsInfoExpectSuggestions = (query: string, expected: string[]) =>
  expectSuggestions(query, expected, mockContext, 'ts_info', undefined, genericAutocomplete);

describe('TS_INFO Autocomplete', () => {
  it('suggests the pipe and a new line after the command', async () => {
    await tsInfoExpectSuggestions('FROM a | TS_INFO ', ['| ', '\n']);
  });

  it('leaves the command name being typed to the command suggestions', async () => {
    await tsInfoExpectSuggestions('FROM a | TS_INFO', []);
  });
});
