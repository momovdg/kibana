/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import type { ScenarioTable } from '../../__tests__/scenarios';
import { esqlCommandRegistry } from '../../commands/registry';
import { locate, locateWholeText } from '../../esql_js_sim/grammar';

const REGISTRY_DIR = join(__dirname, '../../commands/registry');
const SOURCE_START = /^\s*(from|ts|row|show|promql|set)\b/i;
const PIPELINE =
  'FROM logs | EVAL a = ROUND(doubleField, 2), b = TO_STRING(integerField) | WHERE keywordField LIKE "a*" AND doubleField > 10 | STATS c = COUNT(*), m = MAX(doubleField) BY keywordField | SORT c DESC | ';

const loadTables = (): ScenarioTable[] =>
  readdirSync(REGISTRY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      try {
        const exported: Record<string, ScenarioTable> = jest.requireActual(
          join(REGISTRY_DIR, name, 'autocomplete.scenarios.ts')
        );

        return Object.values(exported);
      } catch (error) {
        // A command without a scenario table has no file to load.
        return [];
      }
    });

const differs = (query: string): boolean =>
  JSON.stringify(locate(query, query.length)) !==
  JSON.stringify(locateWholeText(query, query.length));

/**
 * `locate` reads a long query through a window: the commands between the first one and the
 * one at the cursor are blanked out, and described once. It has to say what reading the
 * whole text says.
 */
describe('locate through the window on the command at the cursor', () => {
  const queries = loadTables().flatMap(({ scenarios }) => scenarios.map(({ query }) => query));

  it('agrees with reading the whole text on every scenario query', () => {
    expect(queries.length).toBeGreaterThan(500);
    expect(queries.filter(differs)).toEqual([]);
  });

  it('agrees where the command comes after a long pipeline, a header, a comment or a branch', () => {
    const starts = [
      PIPELINE,
      'FROM a | LIMIT 1 | EVAL x = "a | b" /* c | d */ | ',
      'FROM a | FORK (WHERE b > 1 | LIMIT 2) (EVAL c = 1 | KEEP c) | ',
    ];
    const tails = queries.flatMap((query) => {
      const pipe = query.lastIndexOf('| ');
      const tail = query.slice(pipe + 2);
      const isProcessing = pipe > 0 && !SOURCE_START.test(tail) && !/fork|\(|\)/i.test(query);

      return isProcessing ? [tail] : [];
    });
    const moved = [
      ...tails.flatMap((tail) => starts.map((start) => `${start}${tail}`)),
      ...queries.map((query) => `SET unmapped_fields = "LOAD"; ${query}`),
    ];

    expect(moved.length).toBeGreaterThan(1500);
    expect(moved.filter(differs)).toEqual([]);
  });

  it('agrees key by key, where the window of one key is used for the next', () => {
    const typed = [
      ...esqlCommandRegistry
        .getAllCommands()
        .flatMap(({ metadata }) => metadata.examples ?? [])
        .map((example) => example.replace('…', 'FROM a | LIMIT 1 | KEEP b')),
      `${PIPELINE}WHERE c > 1 AND m < 2 | KEEP c | SORT c`,
      'FROM a | LIMIT 1 | FORK (WHERE b > 1 | LIMIT 2) (EVAL c = 1 | KEEP c) | KEEP c',
    ];
    const differing = typed.flatMap((query) =>
      Array.from({ length: query.length }, (_, index) => query.slice(0, index + 1)).filter(differs)
    );

    expect(differing).toEqual([]);
  });
});
