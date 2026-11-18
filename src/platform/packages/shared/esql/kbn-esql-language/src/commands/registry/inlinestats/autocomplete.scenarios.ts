/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Scenario, ScenarioTable } from '../../../__tests__/scenarios';

const rows = (group: string, name: string, queries: string[], exact: string[]): Scenario[] =>
  queries.map((query) => ({ group, name, query, expect: { exact } }));

const RECOGNITION = 'Multi-token command recognition';
const FIELDS = 'INLINE STATS <aggregations> BY <groupings>';
const WHERE = '... WHERE expression ...';

export const inlineStatsScenarios: ScenarioTable = {
  command: 'inline stats',
  scenarios: [
    ...rows(
      RECOGNITION,
      'suggests STATS after INLINE, with a space or a partial word',
      ['FROM a | INLINE ', 'FROM a | INLINE S'],
      ['STATS ']
    ),
    {
      group: FIELDS,
      name: 'suggests a new name and functions where an aggregation starts',
      query: 'FROM a | INLINE STATS ',
      expect: { contains: ['col0 = ', 'AVG($0)'] },
    },
    {
      group: FIELDS,
      name: 'suggests columns inside an aggregation',
      query: 'FROM a | INLINE STATS AVG(',
      expect: { contains: ['doubleField'] },
    },
    {
      group: FIELDS,
      name: 'suggests a new name where a grouping starts',
      query: 'FROM a | INLINE STATS col0 = AVG(doubleField) BY ',
      expect: { contains: ['col1 = '] },
    },
    ...rows(
      WHERE,
      'suggests subqueries after IN in WHERE',
      [
        'FROM a | INLINE STATS MIN(b) WHERE keywordField IN ',
        'FROM a | INLINE STATS MIN(b) WHERE keywordField NOT IN ',
      ],
      ['($0)', '(FROM $0)', '(ROW $0)', '(TS $0)']
    ),
    ...rows(
      WHERE,
      'does not suggest subqueries after IN outside WHERE',
      ['FROM a | INLINE STATS MIN(b) BY keywordField IN '],
      ['($0)']
    ),
  ],
};
