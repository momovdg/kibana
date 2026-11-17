# Autocomplete scenarios

A scenario is one row of data: a query, a cursor position and the suggestions expected there.
Scenarios are grouped in one table per command, next to the command
(`commands/registry/<command>/autocomplete.scenarios.ts`).

Every scenario goes through `suggest()`, the function the editor calls, with callbacks that
answer from a scenario world. A table never calls a command's own autocomplete, so it describes
what the user sees and does not depend on how the suggestions are produced.

```ts
export const limitScenarios: ScenarioTable = {
  command: 'limit',
  scenarios: [
    {
      group: 'LIMIT <number>',
      name: 'suggests BY and pipe after number',
      query: 'from a | limit 4 ', // text before the cursor
      after: ' | keep a', // optional text after the cursor
      expect: { exact: ['BY ', '| ', '\n'] },
    },
  ],
};
```

- `expect.exact`: the suggestions are exactly these, in any order.
- `expect.contains` and `expect.excludes`: partial checks.
- `world`: overrides of the default world (columns, sources, policies, license and so on). Each
  row runs with its own world: the package's column cache does not carry over between rows.
- `status: 'new'`: a deliberate behaviour change. The row is skipped on flows that do not
  have it.
- `status: 'replaced'`: what the current flow does where the behaviour was changed. The row is
  skipped on the flows that have the change, and a `new` row next to it says what they do.

`describeScenarios(table)` declares one test per row and per flow in `SUGGEST_FLOWS`. Call it
from a test file next to the table:

```ts
// autocomplete.scenarios.test.ts
describeScenarios(limitScenarios);
```

Today `SUGGEST_FLOWS` holds the current flow only. The grammar-driven flow runs the same rows
in `parity.test.ts`, below.

## Parity with the new flow

`parity.test.ts` runs every table through the grammar-driven flow (`language/autocomplete_v2`)
and counts the rows that already match. No row fails that test: the counts are kept in a
snapshot, so a change that moves them, up or down, shows in its diff. Update the snapshot with
`node scripts/jest <path to parity.test.ts> -u`.

Rows tagged `replaced` are left out of the counts and reported as one number; rows tagged
`new` have to pass on the new flow.

A command only the new flow knows has every row tagged `new`.
