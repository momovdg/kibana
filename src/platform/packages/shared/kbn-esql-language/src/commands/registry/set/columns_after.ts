/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLAstAllCommands } from '../../../types';
import type { ESQLColumnData } from '../types';

export const columnsAfter = (
  command: ESQLAstAllCommands,
  previousColumns: ESQLColumnData[],
  query: string
) => {
  // Dummy column for now.
  const columns = [];
  const newColumn = {
    name: 'set_column',
    type: 'integer',
    location: { min: 0, max: 0 },
    userDefined: true,
  };

  columns.push(newColumn);
  return columns;
};
