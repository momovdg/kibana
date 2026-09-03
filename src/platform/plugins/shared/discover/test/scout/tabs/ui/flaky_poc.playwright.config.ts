/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/* PoC #274834 — delete with the branch. */

import type { PlaywrightTestConfig } from '@playwright/test';
import { createPlaywrightConfig } from '@kbn/scout';

const base = createPlaywrightConfig({
  testDir: './parallel_tests',
  workers: 2,
  runGlobalSetup: true,
});

const config: PlaywrightTestConfig = {
  ...base,
  // Round 2: 20 repeats each of run A (original test, 60s budget, expected to
  // fail often — the point is the afterEach dump) and run B (healing probe,
  // ≤4 min budget). 2 workers → ~30-40 min worst-case on CI.
  repeatEach: 20,
  // Only the diagnostic spec. Setup/teardown projects carry their own
  // testMatch for global.setup.ts / global.teardown.ts and are unaffected.
  testMatch: /new_tab\.spec\.ts/,
};

export default config;
