/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { createCustomCallbackMocks, setup } from './helpers';

/**
 * The data callbacks a suggestion request may run, fetched only where something reads them.
 * Columns are still read up front, and the license for every request.
 */
const DATA_CALLBACKS = [
  'getSources',
  'getPolicies',
  'getJoinIndices',
  'getTimeseriesIndices',
  'getViews',
  'getDatasets',
  'getEditorExtensions',
  'getInferenceEndpoints',
  'getPreferences',
] as const;

describe('autocomplete data fetching', () => {
  it.each([
    ['FROM a | LIMIT ^', []],
    // The recommended fields order the columns.
    ['FROM a | WHERE ^', ['getEditorExtensions']],
    ['FROM a | ENRICH ^', ['getPolicies']],
    ['FROM a | LOOKUP JOIN ^', ['getJoinIndices']],
    ['FROM a | STATS COUNT(*) BY ^', ['getEditorExtensions', 'getPreferences']],
    ['FROM ^', ['getDatasets', 'getSources', 'getViews']],
    ['FROM a ^', ['getEditorExtensions']],
    ['TS ^', ['getTimeseriesIndices']],
    ['FROM a | COMPLETION "prompt" WITH { ^', ['getInferenceEndpoints']],
  ])('runs only what %j reads', async (query, expected) => {
    const callbacks = {
      ...createCustomCallbackMocks(),
      getPreferences: jest.fn(async () => ({ histogramBarTarget: 50 })),
    };
    const { suggest } = await setup('^');

    await suggest(query, { callbacks });

    const callCount = (name: (typeof DATA_CALLBACKS)[number]): number => {
      const callback = callbacks[name];
      return jest.isMockFunction(callback) ? callback.mock.calls.length : 0;
    };
    const called = DATA_CALLBACKS.filter((name) => callCount(name) > 0);
    expect(called.sort()).toEqual([...expected].sort());
    // Each runs once per request, however many readers ask for it.
    expect(called.map(callCount)).toEqual(called.map(() => 1));
  });

  it('fetches the inference endpoints for the command’s task', async () => {
    const callbacks = createCustomCallbackMocks();
    const { suggest } = await setup('^');

    await suggest('FROM a | RERANK "query" ON textField WITH { ^', { callbacks });

    expect(callbacks.getInferenceEndpoints).toHaveBeenCalledWith('rerank');
  });
});
