/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLCallbacks } from '@kbn/esql-types';
import type { ESQLAstQueryExpression } from '@elastic/esql/types';
import { ESQL_VARIABLES_PREFIX } from '../../commands/registry/constants';
import type { ESQLColumnData, GetColumnsByTypeFn } from '../../commands/registry/types';
import { buildFieldsDefinitionsWithMetadata } from '../../commands/definitions/utils';
import { QueryColumns } from '../../query_columns_service';

export type ColumnsMap = Map<string, ESQLColumnData>;
export type GetColumnMapFn = () => Promise<ColumnsMap>;

export type EditorExtensionsResult = Awaited<
  ReturnType<NonNullable<ESQLCallbacks['getEditorExtensions']>>
>;
export type GetEditorExtensionsFn = () => Promise<EditorExtensionsResult>;

const defaultExtensions: EditorExtensionsResult = {
  recommendedQueries: [],
  recommendedFields: [],
};

/**
 * The columns at the cursor, by type or as a map, and the editor extensions for the query,
 * each fetched once: the recommended fields order the columns, and the recommended queries
 * follow a source.
 */
export function getColumnsByTypeRetriever(
  query: ESQLAstQueryExpression,
  queryText: string,
  resourceRetriever?: ESQLCallbacks
): {
  getColumnsByType: GetColumnsByTypeFn;
  getColumnMap: GetColumnMapFn;
  getEditorExtensions: GetEditorExtensionsFn;
} {
  const helpers = new QueryColumns(query, queryText, resourceRetriever);
  const getVariables = resourceRetriever?.getVariables;
  const canSuggestVariables = resourceRetriever?.canSuggestVariables?.() ?? false;

  const lastCharacterTyped = queryText[queryText.length - 1];
  const lastCharIsQuestionMark = lastCharacterTyped === ESQL_VARIABLES_PREFIX;

  let extensionsPromise: Promise<EditorExtensionsResult> | undefined;
  const getExtensionsOnce: GetEditorExtensionsFn = () => {
    if (!extensionsPromise) {
      extensionsPromise =
        resourceRetriever
          ?.getEditorExtensions?.(queryText)
          .then((result) => result ?? defaultExtensions)
          .catch(() => defaultExtensions) ?? Promise.resolve(defaultExtensions);
    }
    return extensionsPromise;
  };

  return {
    getColumnsByType: async (
      expectedType: Readonly<string> | Readonly<string[]> = 'any',
      ignored: string[] = [],
      options
    ) => {
      const updatedOptions = {
        ...options,
        supportsControls: canSuggestVariables && !lastCharIsQuestionMark,
      };
      const editorExtensions = await getExtensionsOnce();
      const columns = await helpers.byType(expectedType, ignored);
      return buildFieldsDefinitionsWithMetadata(
        columns,
        editorExtensions.recommendedFields,
        updatedOptions,
        await getVariables?.()
      );
    },
    getColumnMap: helpers.asMap.bind(helpers),
    getEditorExtensions: getExtensionsOnce,
  };
}
