/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import type { ESQLCallbacks } from '@kbn/esql-types';
import type { Position, PositionType } from './positions';

const PACKAGE_PATH = 'src/platform/packages/shared/esql/kbn-esql-language';

/** What the benchmark reads from a checkout of the package: its public suggest(). */
interface LanguagePackage {
  suggest: (text: string, offset: number, callbacks: ESQLCallbacks) => Promise<unknown[]>;
}

interface Locator {
  locateCursor: (text: string, offset: number) => unknown;
}

export interface TypeResult {
  positions: number;
  p50: number;
  p95: number;
  /** Data callback calls per position on the first pass, before any column cache warms up. */
  callbacksPerPosition: Record<string, number>;
  /** The cursor locator alone, where the checkout has one. */
  locator?: { p50: number; p95: number };
}

export interface RunResult {
  node: string;
  root: string;
  coldFirstCall: number;
  types: Record<string, TypeResult>;
  /** Positions where suggest() threw, timed until it did: `text before cursor: message`. */
  errors: string[];
}

/** Calls suggest(), noting where it throws instead of stopping the benchmark. */
const suggestAt = async (
  language: LanguagePackage,
  { query, offset }: Position,
  callbacks: ESQLCallbacks,
  errors: Set<string>
): Promise<void> => {
  try {
    await language.suggest(query, offset, callbacks);
  } catch (error) {
    errors.add(`${JSON.stringify(query.slice(0, offset))}: ${(error as Error).message}`);
  }
};

const percentile = (sorted: number[], fraction: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;

const FIELDS = [
  { name: '@timestamp', type: 'date' },
  { name: 'bytes', type: 'long' },
  { name: 'message', type: 'text' },
  { name: 'host', type: 'keyword' },
  { name: 'agent', type: 'keyword' },
  { name: 'clientip', type: 'ip' },
  { name: 'kb', type: 'double' },
  { name: 'my field', type: 'keyword' },
] as const;

/** Mock callbacks with fixed data, counting each call by name. */
const createCallbacks = (counts: Map<string, number>): ESQLCallbacks => {
  const counted =
    <Args extends unknown[], Result>(name: string, fn: (...args: Args) => Result) =>
    (...args: Args): Result => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return fn(...args);
    };
  const index = { name: 'lookup_index', mode: 'lookup', aliases: [] };
  return {
    getColumnsFor: counted('getColumnsFor', async () =>
      FIELDS.map(({ name, type }) => ({ name, type, userDefined: false as const }))
    ),
    getSources: counted('getSources', async () => [
      { name: 'kibana_sample_data_logs', hidden: false },
      { name: 'logs-app', hidden: false },
    ]),
    getPolicies: counted('getPolicies', async () => [
      { name: 'policy', sourceIndices: ['a'], matchField: 'host', enrichFields: ['geo'] },
    ]),
    getJoinIndices: counted('getJoinIndices', async () => ({ indices: [index] })),
    getTimeseriesIndices: counted('getTimeseriesIndices', async () => ({ indices: [] })),
    getViews: counted('getViews', async () => ({ views: [] })),
    getDatasets: counted('getDatasets', async () => ({ datasets: [] })),
    getEditorExtensions: counted('getEditorExtensions', async () => ({
      recommendedQueries: [],
      recommendedFields: [],
    })),
    getInferenceEndpoints: counted('getInferenceEndpoints', async () => ({
      inferenceEndpoints: [],
    })),
    getPreferences: counted('getPreferences', async () => ({ histogramBarTarget: 50 })),
    getLicense: counted('getLicense', async () => ({ hasAtLeast: () => true })),
  };
};

/**
 * Times the checkout's suggest() at every position: the first call of the process (cold), one
 * warm-up pass counting the callbacks, then `passes` timed passes, grouped by position type.
 */
export const runBenchmark = async (
  positions: Position[],
  root: string,
  passes = 10
): Promise<RunResult> => {
  const packageRoot = join(root, PACKAGE_PATH);
  // Through the package entry, so its modules load in their usual order.
  const language: LanguagePackage = await import(join(packageRoot, 'index.ts'));
  const locatorPath = join(packageRoot, 'src/language/shared/cursor_location/cursor_location.ts');
  const locator: Locator | undefined = existsSync(locatorPath)
    ? await import(locatorPath)
    : undefined;

  const counts = new Map<string, number>();
  const callbacks = createCallbacks(counts);
  const errors = new Set<string>();

  const [first] = positions;
  const coldStart = performance.now();
  await suggestAt(language, first, callbacks, errors);
  const coldFirstCall = performance.now() - coldStart;

  const types = [...new Set(positions.map(({ type }) => type))];
  const callbacksByType = new Map<PositionType, Map<string, number>>();
  counts.clear();
  for (const position of positions) {
    const { type } = position;
    const before = new Map(counts);
    await suggestAt(language, position, callbacks, errors);
    const byType = callbacksByType.get(type) ?? new Map<string, number>();
    for (const [name, total] of counts) {
      byType.set(name, (byType.get(name) ?? 0) + total - (before.get(name) ?? 0));
    }
    callbacksByType.set(type, byType);
  }

  const timings = new Map<PositionType, number[]>();
  const locatorTimings = new Map<PositionType, number[]>();
  for (let pass = 0; pass < passes; pass++) {
    for (const position of positions) {
      const { query, offset, type } = position;
      const start = performance.now();
      await suggestAt(language, position, callbacks, errors);
      timings.set(type, [...(timings.get(type) ?? []), performance.now() - start]);
      if (locator) {
        const locateStart = performance.now();
        locator.locateCursor(query, offset);
        locatorTimings.set(type, [
          ...(locatorTimings.get(type) ?? []),
          performance.now() - locateStart,
        ]);
      }
    }
  }

  const result: RunResult = {
    node: process.version,
    root,
    coldFirstCall,
    types: {},
    errors: [...errors],
  };
  for (const type of types) {
    const sorted = [...(timings.get(type) ?? [])].sort((a, b) => a - b);
    const count = positions.filter((position) => position.type === type).length;
    const located = [...(locatorTimings.get(type) ?? [])].sort((a, b) => a - b);
    result.types[type] = {
      positions: count,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      callbacksPerPosition: Object.fromEntries(
        [...(callbacksByType.get(type) ?? [])].map(([name, total]) => [name, total / count])
      ),
      ...(located.length && {
        locator: { p50: percentile(located, 0.5), p95: percentile(located, 0.95) },
      }),
    };
  }
  return result;
};
