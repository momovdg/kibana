/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { runScenario, SUGGEST_FLOWS } from '../../../__tests__/scenarios';
import * as queryPosition from '../../../commands/definitions/utils/autocomplete/promql/query_position';
import { promqlScenarios } from '../../../commands/registry/promql/autocomplete.scenarios';
import { describePromqlPosition } from './promql_position';

/**
 * How well the position read from the PromQL grammar agrees with the position the current
 * flow reads from the PromQL tree and the text. Every scenario row that reaches the query of
 * the command is run through the current flow; where it asks for the position in the query,
 * the same text and cursor are given to the new reader and the two kinds are compared.
 */
describe('the position in a PromQL query, from the grammar', () => {
  it('agrees with the current flow on these rows', async () => {
    const [current] = SUGGEST_FLOWS;
    const spy = jest.spyOn(queryPosition, 'getQueryPosition');
    const differences: string[] = [];
    let compared = 0;

    for (const scenario of promqlScenarios.scenarios) {
      spy.mockClear();
      await runScenario(scenario, current);

      const call = spy.mock.calls.at(-1);
      const expected = spy.mock.results.at(-1)?.value as { type: string } | undefined;

      if (call && expected) {
        const [, cursor, text] = call;
        // The current flow reads the position without the spaces before the cursor.
        const before = text.slice(0, cursor);
        const { kind } = describePromqlPosition(before, before.length);

        compared++;
        if (kind !== expected.type) {
          differences.push(`${JSON.stringify(before)}: ${expected.type} / ${kind}`);
        }
      }
    }

    spy.mockRestore();

    expect({ compared, agree: compared - differences.length, differences }).toMatchSnapshot();
  });
});
