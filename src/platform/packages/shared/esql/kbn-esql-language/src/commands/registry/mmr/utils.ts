/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLAstItem, ESQLCommand } from '@elastic/esql/types';

export const getItemLocation = (
  item: ESQLAstItem | undefined,
  fallback: ESQLCommand['location']
) => {
  if (!item) {
    return fallback;
  }

  if (Array.isArray(item)) {
    const firstNode = item[0];
    return firstNode && typeof firstNode === 'object' && 'location' in firstNode
      ? firstNode.location
      : fallback;
  }

  return item.location;
};
