/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ICommandCallbacks, ISuggestionItem } from '../../registry/types';

/** The columns of the query so far. One is followed by a space, and the list opens again. */
export const offerColumns = async (callbacks?: ICommandCallbacks): Promise<ISuggestionItem[]> =>
  (await callbacks?.getByType?.('any', undefined, {
    advanceCursor: true,
    openSuggestions: true,
  })) ?? [];
