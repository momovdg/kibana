/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import type { Position } from './positions';
import { runBenchmark, type RunResult } from './run';

const ms = (value: number): string => value.toFixed(2);

/** The base and new results as markdown, one row per position type. */
const compare = (base: RunResult, next: RunResult): string => {
  const types = Object.keys(next.types);
  const callbackNames = [
    ...new Set(
      types.flatMap((type) => [
        ...Object.keys(base.types[type]?.callbacksPerPosition ?? {}),
        ...Object.keys(next.types[type].callbacksPerPosition),
      ])
    ),
  ].sort();
  const lines = [
    `Node ${next.node}. Cold first call: ${ms(base.coldFirstCall)} ms (base), ${ms(
      next.coldFirstCall
    )} ms (new).`,
    '',
    '| Position type | Positions | p50 base | p50 new | p95 base | p95 new | Locator p50 / p95 (new) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...types.map((type) => {
      const b = base.types[type];
      const n = next.types[type];
      const locator = n.locator ? `${ms(n.locator.p50)} / ${ms(n.locator.p95)}` : '–';
      return `| ${type} | ${n.positions} | ${ms(b?.p50 ?? 0)} | ${ms(n.p50)} | ${ms(
        b?.p95 ?? 0
      )} | ${ms(n.p95)} | ${locator} |`;
    }),
    '',
    'Data callback calls per position (first pass, before the column cache warms up), base → new:',
    '',
    `| Position type | ${callbackNames.join(' | ')} |`,
    `| --- | ${callbackNames.map(() => '---').join(' | ')} |`,
    ...types.map(
      (type) =>
        `| ${type} | ${callbackNames
          .map(
            (name) =>
              `${(base.types[type]?.callbacksPerPosition[name] ?? 0).toFixed(2)} → ${(
                next.types[type].callbacksPerPosition[name] ?? 0
              ).toFixed(2)}`
          )
          .join(' | ')} |`
    ),
    '',
    `Positions where suggest() threw: ${base.errors.length} (base), ${next.errors.length} (new).`,
    ...[
      ...base.errors.map((error) => `- base: ${error}`),
      ...next.errors.map((e) => `- new: ${e}`),
    ],
  ];
  return lines.join('\n');
};

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));

/** `positions <out>`, `run <positions> <out> [--root <checkout>]`, `compare <base> <new>`. */
export const main = async ([command, ...args]: string[]): Promise<void> => {
  if (command === 'positions') {
    // Uses the cursor locator, so only this checkout can classify the positions.
    const { buildPositions } = await import('./positions');
    const positions = buildPositions();
    writeFileSync(args[0], JSON.stringify(positions, null, 1));
    process.stdout.write(`Wrote ${positions.length} positions to ${args[0]}\n`);
    return;
  }
  if (command === 'run') {
    const rootFlag = args.indexOf('--root');
    const root = rootFlag >= 0 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
    const result = await runBenchmark(read<Position[]>(args[0]), root);
    writeFileSync(args[1], JSON.stringify(result, null, 1));
    process.stdout.write(`Wrote the results for ${root} to ${args[1]}\n`);
    return;
  }
  if (command === 'compare') {
    process.stdout.write(`${compare(read<RunResult>(args[0]), read<RunResult>(args[1]))}\n`);
    return;
  }
  throw new Error(
    'Usage: positions <out> | run <positions> <out> [--root <dir>] | compare <base> <new>'
  );
};
