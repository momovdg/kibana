/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLCallbacks } from '@kbn/esql-types';
import { createLazyContext } from './lazy_context';

const policy = { name: 'policy', sourceIndices: ['a'], matchField: 'm', enrichFields: ['e'] };
const index = { name: 'index', mode: 'lookup', aliases: [] };
const endpoint = { inference_id: 'endpoint', task_type: 'completion' };

const createCallbacks = () => ({
  getSources: jest.fn(async () => [{ name: 'index', hidden: false }]),
  getPolicies: jest.fn(async () => [policy]),
  getViews: jest.fn(async () => ({ views: [{ name: 'view', query: 'FROM a' }] })),
  getDatasets: jest.fn(async () => ({
    datasets: [{ name: 'dataset', data_source: 's3', resource: 's3://bucket' }],
  })),
  getJoinIndices: jest.fn(async () => ({ indices: [index] })),
  getTimeseriesIndices: jest.fn(async () => ({ indices: [index] })),
  getInferenceEndpoints: jest.fn(async () => ({ inferenceEndpoints: [endpoint] })),
  getEditorExtensions: jest.fn(async () => ({ recommendedQueries: [], recommendedFields: [] })),
  getPreferences: jest.fn(async () => ({ histogramBarTarget: 100 })),
  getLicense: jest.fn(async () => ({ hasAtLeast: () => true })),
});

const createContext = (callbacks: ESQLCallbacks | undefined = createCallbacks()) => {
  const getColumnMap = jest.fn(async () => new Map());
  return {
    context: createLazyContext({ callbacks, queryString: 'FROM a ', getColumnMap }),
    getColumnMap,
  };
};

describe('createLazyContext', () => {
  it('fetches nothing until a getter is read', () => {
    const callbacks = createCallbacks();
    const { getColumnMap } = createContext(callbacks);

    expect(getColumnMap).not.toHaveBeenCalled();
    for (const callback of Object.values(callbacks)) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it('calls each callback at most once per context', async () => {
    const callbacks = createCallbacks();
    const { context, getColumnMap } = createContext(callbacks);

    for (let read = 0; read < 2; read++) {
      await Promise.all([
        context.columns(),
        context.policies(),
        context.sources(),
        context.views(),
        context.datasets(),
        context.joinIndices(),
        context.timeSeriesSources(),
        context.inferenceEndpoints('completion'),
        context.editorExtensions(),
        context.histogramBarTarget(),
        context.license(),
      ]);
    }

    expect(getColumnMap).toHaveBeenCalledTimes(1);
    for (const callback of Object.values(callbacks)) {
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });

  it('returns what the callbacks give, shaped as the eager context', async () => {
    const { context } = createContext();

    expect(await context.policies()).toEqual(new Map([['policy', policy]]));
    expect(await context.views()).toEqual([{ name: 'view', query: 'FROM a' }]);
    expect(await context.joinIndices()).toEqual([index]);
    expect(await context.inferenceEndpoints('completion')).toEqual([endpoint]);
    expect(await context.histogramBarTarget()).toBe(100);
  });

  it('reads the editor extensions for the query', async () => {
    const callbacks = createCallbacks();
    const { context } = createContext(callbacks);

    await context.editorExtensions();

    expect(callbacks.getEditorExtensions).toHaveBeenCalledWith('FROM a ');
  });

  it('memoizes the inference endpoints per task type', async () => {
    const callbacks = createCallbacks();
    const { context } = createContext(callbacks);

    await context.inferenceEndpoints('completion');
    await context.inferenceEndpoints('rerank');
    await context.inferenceEndpoints('completion');

    expect(callbacks.getInferenceEndpoints.mock.calls).toEqual([['completion'], ['rerank']]);
  });

  it('gives the empty defaults without callbacks', async () => {
    const { context } = createContext({});

    expect(await context.policies()).toEqual(new Map());
    expect(await context.sources()).toEqual([]);
    expect(await context.views()).toEqual([]);
    expect(await context.datasets()).toEqual([]);
    expect(await context.joinIndices()).toEqual([]);
    expect(await context.timeSeriesSources()).toEqual([]);
    expect(await context.inferenceEndpoints('completion')).toEqual([]);
    expect(await context.editorExtensions()).toEqual({
      recommendedQueries: [],
      recommendedFields: [],
    });
    expect(await context.histogramBarTarget()).toBe(50);
    expect(await context.license()).toBeUndefined();
  });

  it('gives the same defaults when a callback rejects', async () => {
    const failing = async () => {
      throw new Error('unavailable');
    };
    const { context } = createContext({
      getSources: failing,
      getPolicies: failing,
      getJoinIndices: failing,
      getInferenceEndpoints: failing,
      getEditorExtensions: failing,
      getPreferences: failing,
    });

    expect(await context.sources()).toEqual([]);
    expect(await context.policies()).toEqual(new Map());
    expect(await context.joinIndices()).toEqual([]);
    expect(await context.inferenceEndpoints('rerank')).toEqual([]);
    expect(await context.editorExtensions()).toEqual({
      recommendedQueries: [],
      recommendedFields: [],
    });
    expect(await context.histogramBarTarget()).toBe(50);
  });
});
