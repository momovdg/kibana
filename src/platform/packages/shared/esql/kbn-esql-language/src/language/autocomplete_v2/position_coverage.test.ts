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
import { COMMAND_FACTS, resolveRole } from '../../esql_js_sim/definitions';
import {
  getCommandStarts,
  getGrammarPositions,
  locate,
  withoutRecursion,
  type GrammarPosition,
} from '../../esql_js_sim/grammar';
import { getRegisteredCommand } from './command_metadata';

const REGISTRY_DIR = join(__dirname, '../../commands/registry');
const SEPARATOR = ' / ';

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

/** Every place the grammar expects something at the cursor of a row, and the places above it. */
const reachedBy = ({ scenarios }: ScenarioTable): string[] =>
  scenarios
    // A row that holds what only the current flow does is not a row of this flow.
    .filter(({ status }) => status !== 'replaced')
    .flatMap(({ query, after = '' }) => {
      const { arguments: expected, followers } = locate(`${query}${after}`, query.length);

      return [
        ...expected.map(({ path }) => path),
        // A token with no fixed text that a rule takes directly is a place too.
        ...followers.map(({ class: tokenClass, id, path }) =>
          tokenClass === 'value' && id ? [...path, id] : path
        ),
      ];
    })
    .flatMap((path) => {
      const folded = withoutRecursion(path);

      return folded.map((_, index) => folded.slice(0, index + 1).join(SEPARATOR));
    });

/**
 * The gate before the new flow replaces the current one: every place of a registered command
 * that takes something the user chooses is the cursor of at least one scenario row. A place a
 * grammar upgrade adds fails here until a row says what is offered there.
 */
describe('the scenario rows', () => {
  const registered = Object.keys(getCommandStarts()).filter(getRegisteredCommand);
  const positions = getGrammarPositions().filter(({ command }) => registered.includes(command));
  const reached = new Set(loadTables().flatMap(reachedBy));

  // The options of a command that ends with a text in another language are read from the
  // tokens, not located: its rows are checked by what they offer.
  const isReadFromTokens = (command: string): boolean =>
    positions.some((position) => {
      const role = position.command === command && resolveRole(position.path, position.takes)?.role;

      return role && role.kind === 'sublanguage' && role.options !== undefined;
    });
  // A place Elasticsearch does not support yet is never offered.
  const isUnsupported = ({ command, path }: GrammarPosition): boolean =>
    path.some((id) => COMMAND_FACTS[command]?.unsupported?.includes(id));

  it('reach every place of every registered command', () => {
    const missing = positions
      .filter((position) => !isReadFromTokens(position.command) && !isUnsupported(position))
      .filter(({ path }) => !reached.has(path.join(SEPARATOR)))
      .map(({ command, path }) => `${command}: ${path.join(SEPARATOR)}`);

    expect(positions.length).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it('leave out only the commands whose options are read from the tokens', () => {
    expect(registered.filter(isReadFromTokens)).toEqual(['promqlCommand']);
  });
});
