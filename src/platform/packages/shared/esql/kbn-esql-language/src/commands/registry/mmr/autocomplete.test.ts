/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { mockContext, getMockCallbacks } from '../../../__tests__/commands/context_fixtures';
import {
  expectSuggestions,
  getFunctionSignaturesByReturnType,
  suggest,
} from '../../../__tests__/commands/autocomplete';
import {
  denseVectorLiteralCompleteItem,
  newLineCompleteItem,
  onCompleteItem,
  pipeCompleteItem,
  withCompleteItem,
} from '../complete_items';
import { genericAutocomplete as autocomplete } from '../generic_autocomplete/command_autocomplete';
import type { ESQLColumnData, ICommandCallbacks } from '../types';
import { Location } from '../types';

const buildContextWithDenseVector = () => {
  const columns = new Map<string, ESQLColumnData>(mockContext.columns);
  columns.set('denseField', { name: 'denseField', type: 'dense_vector', userDefined: false });

  return {
    ...mockContext,
    columns,
  };
};

const expectMmrSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext,
  offset?: number
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'mmr',
    mockCallbacks,
    autocomplete,
    offset
  );
};

const suggestMmr = async (query: string, context = buildContextWithDenseVector()) => {
  const results = await suggest(query, context, 'mmr', getMockCallbacks(), autocomplete);
  return results.map(({ text }) => text);
};

describe('MMR Autocomplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('suggests a query vector, dense-vector functions and ON after the MMR keyword', async () => {
    const texts = await suggestMmr('FROM a | MMR ');

    expect(texts).toEqual(
      expect.arrayContaining([
        denseVectorLiteralCompleteItem.text,
        onCompleteItem.text,
        ...getFunctionSignaturesByReturnType(Location.MMR, 'dense_vector', { scalar: true }),
      ])
    );
  });

  // The query vector is a constant: a literal, a parameter or a function's result.
  it('suggests no columns for the query vector', async () => {
    const texts = await suggestMmr('FROM a | MMR ');

    expect(texts).not.toContain('denseField');
  });

  it('suggests ON after the query vector', async () => {
    await expectMmrSuggestions('FROM a | MMR [0.1, 0.2]::dense_vector ', [onCompleteItem.text]);
  });

  it('suggests only dense vector columns after ON', async () => {
    const context = buildContextWithDenseVector();
    const mockCallbacks = getMockCallbacks();
    (mockCallbacks.getByType as jest.Mock).mockImplementation(async (types: string[]) =>
      types.includes('dense_vector') ? [{ label: 'denseField', text: 'denseField' }] : []
    );

    await expectMmrSuggestions('FROM a | MMR ON ', ['denseField'], mockCallbacks, context);
  });

  it('does not suggest ON while the cursor is inside the query vector function arguments', async () => {
    const texts = await suggestMmr('FROM a | MMR TO_DENSE_VECTOR(');

    expect(texts).not.toContain(onCompleteItem.text);
  });

  it('suggests LIMIT after the field', async () => {
    await expectMmrSuggestions(
      'FROM a | MMR ON denseField ',
      ['LIMIT '],
      undefined,
      buildContextWithDenseVector()
    );
  });

  it('suggests limit values after the LIMIT keyword', async () => {
    await expectMmrSuggestions(
      'FROM a | MMR ON denseField LIMIT ',
      ['10 ', '100 ', '1000 '],
      undefined,
      buildContextWithDenseVector()
    );
  });

  it('suggests WITH, pipe and new line after the limit value', async () => {
    await expectMmrSuggestions(
      'FROM a | MMR ON denseField LIMIT 10 ',
      [newLineCompleteItem.text, withCompleteItem.text, pipeCompleteItem.text],
      undefined,
      buildContextWithDenseVector()
    );
  });

  // A trailing comment makes the parser add an `ON` option that starts nowhere; the vector is
  // still the expression the cursor follows.
  it('suggests ON after the query vector and a comment', async () => {
    await expectMmrSuggestions('FROM a | MMR [0.1]::dense_vector /* c */ ', [onCompleteItem.text]);
  });

  it('suggests nothing after a WITH typed by hand; the WITH item opens the map', async () => {
    await expectMmrSuggestions(
      'FROM a | MMR ON denseField LIMIT 10 WITH ',
      [],
      undefined,
      buildContextWithDenseVector()
    );
  });

  it('suggests the lambda key inside the options map', async () => {
    const texts = await suggestMmr('FROM a | MMR ON denseField LIMIT 10 WITH { ');

    expect(texts).toEqual(['"lambda": '].map((text) => expect.stringContaining(text)));
  });

  it('suggests a lambda value', async () => {
    const texts = await suggestMmr('FROM a | MMR ON denseField LIMIT 10 WITH { "lambda": ');

    expect(texts).toEqual(['0.5']);
  });
});
