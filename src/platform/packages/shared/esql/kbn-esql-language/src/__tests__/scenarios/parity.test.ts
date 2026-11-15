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
import { passesOn } from '.';
import type { ScenarioTable, SuggestFlow } from '.';
import { suggest } from '../../language/autocomplete_v2/suggest';

const REGISTRY_DIR = join(__dirname, '../../commands/registry');
const TABLE_FILE = 'autocomplete.scenarios.ts';

const newFlow: SuggestFlow = { name: 'v2', suggest, runsNewRows: true };

/** Every scenario table of the registered commands, found by its file name. */
const loadTables = (): ScenarioTable[] =>
  readdirSync(REGISTRY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      try {
        const exported: Record<string, ScenarioTable> = jest.requireActual(
          join(REGISTRY_DIR, name, TABLE_FILE)
        );

        return Object.values(exported);
      } catch (error) {
        // A command without a scenario table has no file to load.
        return [];
      }
    });

/**
 * How much of the current flow's behaviour the new flow has. Each row of each scenario table
 * runs through the new flow and is counted as matching or not; no row fails this test. The
 * numbers are kept in a snapshot, so a step that moves them shows it, in either direction.
 *
 * A behaviour that was changed on purpose has two rows: one tagged `replaced`, which holds
 * what the current flow does and is left out of the count, and one tagged `new`, which holds
 * what the new flow does and has to pass.
 */
describe('parity of the new flow with the current flow', () => {
  const tables = loadTables().sort((a, b) => a.command.localeCompare(b.command));

  it('matches these rows of each scenario table', async () => {
    const lines: string[] = [];
    let matched = 0;
    let total = 0;
    let replaced = 0;

    for (const { command, scenarios } of tables) {
      const parityRows = scenarios.filter(({ status }) => status === undefined);
      let passing = 0;

      for (const scenario of parityRows) {
        if (await passesOn(scenario, newFlow)) {
          passing++;
        }
      }

      matched += passing;
      total += parityRows.length;
      replaced += scenarios.filter(({ status }) => status === 'replaced').length;
      lines.push(`${command}: ${passing} of ${parityRows.length}`);
    }

    expect(tables.length).toBeGreaterThan(30);
    expect([
      `all commands: ${matched} of ${total}`,
      `replaced on purpose: ${replaced}`,
      ...lines,
    ]).toMatchSnapshot();
  });

  it('has the behaviour of every row tagged as new', async () => {
    const failing: string[] = [];

    for (const { command, scenarios } of tables) {
      for (const scenario of scenarios.filter(({ status }) => status === 'new')) {
        if (!(await passesOn(scenario, newFlow))) {
          failing.push(`${command}: ${scenario.query}▮${scenario.after ?? ''}`);
        }
      }
    }

    expect(failing).toEqual([]);
  });
});
