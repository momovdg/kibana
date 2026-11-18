/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { writeFileSync } from 'fs';
// The package entry is loaded first: its modules have to be evaluated in the package's order.
import { suggest as currentSuggest } from '../../..';
import { createCallbacks } from '../../__tests__/scenarios';
import { locate } from '../../esql_js_sim/grammar';
import { collect } from './collect';
import { suggest } from './suggest';

/*
 * The time of one call to `suggest` in both flows, at the positions an editor is at most.
 * Not a test: it runs only when asked for, from the Kibana root:
 *
 *   ESQL_AUTOCOMPLETE_BENCHMARK=1 node scripts/jest \
 *     src/platform/packages/shared/esql/kbn-esql-language/src/language/autocomplete_v2/benchmark.test.ts
 *
 * Set ESQL_AUTOCOMPLETE_BENCHMARK to a file path to also write the table there. The editor
 * is faked: its callbacks answer at once, so the numbers are the cost of the flows alone.
 */

const PIPELINE =
  'FROM logs | EVAL a = ROUND(doubleField, 2), b = TO_STRING(integerField) | WHERE keywordField LIKE "a*" AND doubleField > 10 | STATS c = COUNT(*), m = MAX(doubleField) BY keywordField | SORT c DESC | ';
const CONDITIONS = `FROM logs | WHERE ${Array.from(
  { length: 40 },
  (_, index) => `doubleField > ${index} AND`
).join(' ')} `;

const POSITIONS: Array<[name: string, query: string]> = [
  ['empty query', ''],
  ['after a pipe', 'FROM logs | '],
  ['source name', 'FROM '],
  ['column list', 'FROM logs | KEEP keywordField, '],
  ['expression start', 'FROM logs | WHERE '],
  ['after an operand', 'FROM logs | WHERE doubleField '],
  ['function argument', 'FROM logs | EVAL x = ROUND(doubleField, '],
  ['aggregation', 'FROM logs | STATS AVG('],
  ['grouping', 'FROM logs | STATS COUNT(*) BY '],
  ['keyword position', 'FROM logs | SORT keywordField '],
  ['word being typed', 'FROM logs | WHERE doubleF'],
  ['whole word', 'FROM logs | KEEP keywordField'],
  ['map key', 'FROM logs | COMPLETION "p" WITH { '],
  ['join condition', 'FROM logs | LOOKUP JOIN join_index ON '],
  ['promql value', 'PROMQL index='],
  ['promql query', 'PROMQL step=5m sum(rate(doubleField[5m])) by ('],
  ['long pipeline, short command', `${PIPELINE}LIMIT `],
  ['long pipeline, expression', `${PIPELINE}WHERE c > `],
  ['40 conditions', CONDITIONS],
];

const WARM_UP_RUNS = 5;
const RUNS = 30;

/** The median time of a call, in milliseconds, once the caches are warm. */
const timeOf = async (call: () => unknown): Promise<number> => {
  for (let run = 0; run < WARM_UP_RUNS; run++) {
    await call();
  }

  const samples: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    await call();
    samples.push(performance.now() - start);
  }

  return samples.sort((a, b) => a - b)[Math.floor(RUNS / 2)];
};

const target = process.env.ESQL_AUTOCOMPLETE_BENCHMARK;

(target ? describe : describe.skip)('benchmark of the two autocomplete flows', () => {
  it('times one call at each position', async () => {
    const callbacks = createCallbacks();
    const cell = (value: number): string => value.toFixed(2).padStart(9);
    const lines = [
      `${'position'.padEnd(30)} chars items   current       new     ratio |    locate   collect`,
    ];
    const totals = { current: 0, next: 0 };

    for (const [name, query] of POSITIONS) {
      const at = query.length;
      const current = await timeOf(() => currentSuggest(query, at, callbacks));
      const next = await timeOf(() => suggest(query, at, callbacks));
      // Where the time of the new flow goes: the grammar position, and everything before
      // the items are presented.
      const located = await timeOf(() => locate(query, at));
      const collected = await timeOf(() => collect(query, at, callbacks));
      const { length: items } = await suggest(query, at, callbacks);

      totals.current += current;
      totals.next += next;
      lines.push(
        `${name.padEnd(30)} ${String(at).padStart(5)} ${String(items).padStart(5)} ${cell(
          current
        )} ${cell(next)} ${cell(next / current)} | ${cell(located)} ${cell(collected)}`
      );
    }

    lines.push(
      `${'total'.padEnd(30)} ${''.padStart(11)} ${cell(totals.current)} ${cell(totals.next)} ${cell(
        totals.next / totals.current
      )}`
    );

    const table = lines.join('\n');

    process.stdout.write(`\n${table}\n`);
    if (target && target !== '1') {
      writeFileSync(target, table);
    }

    expect(lines.length).toBe(POSITIONS.length + 2);
  }, 300000);
});
