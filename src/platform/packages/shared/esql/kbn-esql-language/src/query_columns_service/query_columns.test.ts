/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Parser } from '@elastic/esql';
import { QueryColumns } from '.';

describe('QueryColumns', () => {
  it('computes the columns once for concurrent readers', async () => {
    const query = 'FROM index | EVAL total = bytes * 2';
    const { root } = Parser.parse(query);
    const getColumnsFor = jest.fn(async () => [
      { name: 'bytes', type: 'long' as const, userDefined: false as const },
    ]);
    // Without the cross-request cache, every computation would fetch again.
    const columns = new QueryColumns(
      root,
      query,
      { getColumnsFor },
      { invalidateColumnsCache: true }
    );

    const [map, numbers] = await Promise.all([columns.asMap(), columns.byType('long')]);

    expect([...map.keys()].sort()).toEqual(['bytes', 'total']);
    expect(numbers.map(({ name }) => name).sort()).toEqual(['bytes', 'total']);
    expect(getColumnsFor).toHaveBeenCalledTimes(1);
  });
});
