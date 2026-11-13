/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

// The package entry is loaded first: its modules have to be evaluated in the package's order.
import { suggest as currentSuggest } from '../../../..';
import { createCallbacks } from '../../../__tests__/scenarios';
import { suggest } from '../suggest';

// The columns of a query are cached by its text: these tests read a source of their own.
const callbacks = createCallbacks({
  columns: [
    { name: 'k', type: 'keyword', userDefined: false },
    { name: 'n', type: 'long', userDefined: false },
    { name: 'b', type: 'boolean', userDefined: false },
  ],
});

const textsOf = async (flow: typeof suggest, query: string): Promise<string[]> =>
  (await flow(query, query.length, callbacks)).map(({ text }) => text).sort();

/**
 * Expression positions that no scenario table has a row for, compared item by item with the
 * current flow: right after a cast, and the operators with rules of their own inside the call
 * of a function.
 */
describe('expression positions the scenario tables do not cover', () => {
  describe('right after a cast', () => {
    it.each([
      'FROM c | WHERE n::',
      'FROM c | WHERE n::lo',
      'FROM c | EVAL a = k::',
      'FROM c | EVAL a = ROUND(n::',
      'FROM c | EVAL a = (n + 1)::',
      'FROM c | EVAL a = n::long ',
    ])('offers at the end of %j what the current flow offers', async (query) => {
      expect(await textsOf(suggest, query)).toEqual(await textsOf(currentSuggest, query));
    });
  });

  describe('a list in brackets', () => {
    it.each([
      'FROM c | WHERE (k, n) ',
      'FROM c | WHERE (k, ',
      'FROM c | WHERE (k, n ',
      'FROM c | WHERE (k, n) IN ',
    ])('offers at the end of %j what the current flow offers', async (query) => {
      expect(await textsOf(suggest, query)).toEqual(await textsOf(currentSuggest, query));
    });
  });

  it('offers boolean operands right after NOT at the start of an argument', async () => {
    // The current flow offers nothing here; outside a call it offers these too.
    const texts = await textsOf(suggest, 'FROM c | EVAL a = CASE(NOT ');

    expect(texts).toEqual(expect.arrayContaining(['b ', 'STARTS_WITH($0)']));
    expect(await textsOf(currentSuggest, 'FROM c | EVAL a = CASE(NOT ')).toEqual([]);
  });

  describe('inside the call of a function', () => {
    it.each([
      'FROM c | EVAL a = CASE(n IN ',
      'FROM c | EVAL a = CASE(n IN (',
      'FROM c | EVAL a = CASE(n IN (1, ',
      'FROM c | EVAL a = CASE(n IN (1 ',
      'FROM c | EVAL a = CASE(n IN (1, 2) ',
      'FROM c | EVAL a = CASE(k LIKE ',
      'FROM c | EVAL a = CASE(k LIKE "a*" ',
      'FROM c | EVAL a = CASE(k NOT LIKE "a*" ',
      'FROM c | EVAL a = CASE(k IS ',
      'FROM c | EVAL a = CASE(k IS NOT ',
      'FROM c | EVAL a = CASE(k IS NULL ',
      'FROM c | EVAL a = CASE(k NOT ',
      'FROM c | EVAL a = CASE(NOT b ',
      'FROM c | EVAL a = COALESCE(k : ',
    ])('offers at the end of %j what the current flow offers', async (query) => {
      expect(await textsOf(suggest, query)).toEqual(await textsOf(currentSuggest, query));
    });
  });
});
