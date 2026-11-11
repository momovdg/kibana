/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createIndicesBrowserSuggestion } from '../../../registry/complete_items';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem } from '../../../registry/types';
import { buildResourceBrowserCommandArgs } from '../../../../language/autocomplete/autocomplete_utils';

/**
 * The "Browse data sources" item, in the main query only. The catalogs it lists are read only
 * when the item is offered.
 */
export async function getIndicesBrowserSuggestion({
  callbacks,
  isCursorInSubquery,
  sources,
  timeSeriesSources,
}: {
  callbacks?: ICommandCallbacks;
  isCursorInSubquery?: boolean;
  sources: () => Promise<NonNullable<ICommandContext['sources']>>;
  timeSeriesSources?: () => Promise<NonNullable<ICommandContext['timeSeriesSources']>>;
}): Promise<ISuggestionItem | undefined> {
  const canSuggestResourceBrowser = (await callbacks?.canSuggestResourceBrowser?.()) ?? false;
  if (!canSuggestResourceBrowser || isCursorInSubquery) {
    return undefined;
  }

  const [allSources, allTimeSeriesSources] = await Promise.all([sources(), timeSeriesSources?.()]);
  const commandArgs = buildResourceBrowserCommandArgs({
    // Do not show hidden sources in the resource browser
    sources: allSources.filter((source) => !source.hidden),
    timeSeriesSources: allTimeSeriesSources,
  });

  return createIndicesBrowserSuggestion(commandArgs);
}
