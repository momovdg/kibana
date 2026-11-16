/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { locatePromql } from '../../grammar';
import { getPromqlPart } from './promql_parts';

// One query per kind of place a PromQL query has, each read at its end.
const QUERIES = [
  '',
  'rate(',
  'a{',
  'a{job=',
  'a{job="x", ',
  'a[',
  'rate(a[5m])[',
  'a offset ',
  'a @ ',
  'sum by (',
  'sum without (a, ',
  'a + on (',
  'a + ignoring (b) group_left (',
  'sum(rate(a[5m])) + ',
  'quantile_over_time(0, ',
  'a > bool ',
];

describe('PROMQL_PARTS', () => {
  it('says what every place the locator reports is', () => {
    const unknown = QUERIES.flatMap((query) =>
      locatePromql(query, query.length)
        .rules.filter((expected) => getPromqlPart(expected) === undefined)
        .map(({ rule, path }) => `${JSON.stringify(query)}: ${path.at(-1)}>${rule}`)
    );

    expect(unknown).toEqual([]);
  });

  it.each([
    ['a{', 'label_name'],
    ['a{job=', 'label_value'],
    ['sum by (', 'listed_label'],
    ['a[', 'range'],
    ['a offset ', 'offset'],
    ['a @ ', 'time'],
  ])('reads the place at the end of %j as %s', (query, part) => {
    const parts = locatePromql(query, query.length).rules.map(getPromqlPart);

    expect(parts).toContain(part);
  });
});
