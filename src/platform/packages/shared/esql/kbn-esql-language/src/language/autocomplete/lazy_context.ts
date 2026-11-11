/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLCallbacks } from '@kbn/esql-types';
import type { EditorExtensions } from '../../commands/registry/options/recommended_queries';
import type { ESQLPolicy, ICommandContext } from '../../commands/registry/types';
import type { ColumnsMap, GetColumnMapFn } from '../shared/columns_retrieval_helpers';

type License = Awaited<ReturnType<NonNullable<ESQLCallbacks['getLicense']>>>;

/** The histogram bar target when the preferences don't set one. */
const DEFAULT_HISTOGRAM_BAR_TARGET = 50;

/**
 * The data a suggestion request may need, fetched only when something reads it. Each getter
 * calls its callback at most once per context; nothing is kept across requests.
 */
export interface LazyCommandContext {
  columns(): Promise<ColumnsMap>;
  policies(): Promise<Map<string, ESQLPolicy>>;
  sources(): Promise<NonNullable<ICommandContext['sources']>>;
  views(): Promise<NonNullable<ICommandContext['views']>>;
  datasets(): Promise<NonNullable<ICommandContext['datasets']>>;
  joinIndices(): Promise<NonNullable<ICommandContext['joinSources']>>;
  timeSeriesSources(): Promise<NonNullable<ICommandContext['timeSeriesSources']>>;
  /** Memoized per task type, as `completion` or `rerank`. */
  inferenceEndpoints(taskType: string): Promise<NonNullable<ICommandContext['inferenceEndpoints']>>;
  editorExtensions(): Promise<EditorExtensions>;
  histogramBarTarget(): Promise<number>;
  license(): Promise<License>;
}

/**
 * A getter that loads its value on the first call and returns the same promise afterwards. A
 * missing or failing callback gives the fallback, as an empty list.
 */
const once = <T>(load: () => Promise<T | undefined> | undefined, fallback: T) => {
  let value: Promise<T> | undefined;
  return (): Promise<T> =>
    (value ??= Promise.resolve()
      .then(load)
      .then((result) => result ?? fallback)
      .catch(() => fallback));
};

/**
 * The lazy context of one suggestion request. `queryString` is the text the editor extensions
 * are read for; `getColumnMap` computes the columns at the cursor.
 */
export const createLazyContext = ({
  callbacks,
  queryString,
  getColumnMap,
}: {
  callbacks?: ESQLCallbacks;
  queryString: string;
  getColumnMap: GetColumnMapFn;
}): LazyCommandContext => {
  const inferenceEndpointsByTaskType = new Map<
    string,
    () => Promise<NonNullable<ICommandContext['inferenceEndpoints']>>
  >();

  return {
    columns: once(getColumnMap, new Map()),
    policies: once(
      async () =>
        new Map(((await callbacks?.getPolicies?.()) ?? []).map((policy) => [policy.name, policy])),
      new Map()
    ),
    sources: once(async () => callbacks?.getSources?.(), []),
    views: once(async () => (await callbacks?.getViews?.())?.views, []),
    datasets: once(async () => (await callbacks?.getDatasets?.())?.datasets, []),
    joinIndices: once(async () => (await callbacks?.getJoinIndices?.())?.indices, []),
    timeSeriesSources: once(async () => (await callbacks?.getTimeseriesIndices?.())?.indices, []),
    inferenceEndpoints: (taskType) => {
      let getter = inferenceEndpointsByTaskType.get(taskType);
      if (!getter) {
        getter = once(
          async () => (await callbacks?.getInferenceEndpoints?.(taskType))?.inferenceEndpoints,
          []
        );
        inferenceEndpointsByTaskType.set(taskType, getter);
      }
      return getter();
    },
    editorExtensions: once(async () => callbacks?.getEditorExtensions?.(queryString), {
      recommendedQueries: [],
      recommendedFields: [],
    }),
    histogramBarTarget: once(
      async () =>
        (await callbacks?.getPreferences?.())?.histogramBarTarget || DEFAULT_HISTOGRAM_BAR_TARGET,
      DEFAULT_HISTOGRAM_BAR_TARGET
    ),
    license: once(async () => callbacks?.getLicense?.(), undefined),
  };
};
