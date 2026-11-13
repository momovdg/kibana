/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { EsqlQuery } from '@elastic/esql';
import { getRecommendedQueriesSuggestions } from '../../../commands/registry/options/recommended_queries';
import type { ISuggestionItem } from '../../../commands/registry/types';
import { resolveRole } from '../../../esql_js_sim/definitions';
import { getColumnsByTypeRetriever } from '../../shared/columns_retrieval_helpers';
import { RECOMMENDED_QUERIES } from '../presentation';
import type { SuggestionContext } from '../types';

const NO_EXTENSIONS = { recommendedQueries: [], recommendedFields: [] };

/**
 * What the editor offers beyond the next token of the grammar. After the sources of a query,
 * where the next command can start: queries that are ready to run on those sources.
 */
export const provideExtras = async (context: SuggestionContext): Promise<ISuggestionItem[]> => {
  const { ir, callbacks, text, offset } = context;
  const last = ir.written.at(-1);
  const canStartNextCommand = ir.followers.some((follower) => follower.class === 'pipe');

  if (ir.word || last?.kind !== 'rule' || !canStartNextCommand) {
    return [];
  }

  const resolved = resolveRole([...last.ancestors.map(({ id }) => id), last.id]);
  const isSource = resolved?.role.kind === 'entity' && resolved.role.entityType === 'source';
  const queries = resolved?.enclosing
    .map(({ id }) => RECOMMENDED_QUERIES[id])
    .find((kind) => kind !== undefined);

  if (!isSource || !queries) {
    return [];
  }

  // The queries run on what the sources give, so they read the columns of the query so far,
  // the command at the cursor included.
  const queryBefore = text.slice(0, offset);
  const extensions = (await callbacks?.getEditorExtensions?.(queryBefore)) ?? NO_EXTENSIONS;
  const { getColumnsByType } = getColumnsByTypeRetriever(
    EsqlQuery.fromSrc(queryBefore).ast,
    queryBefore,
    callbacks
  );

  return getRecommendedQueriesSuggestions(
    extensions,
    queries === 'with_templates' ? getColumnsByType : undefined
  );
};
