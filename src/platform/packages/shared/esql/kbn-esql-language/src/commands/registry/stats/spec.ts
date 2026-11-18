/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { keyword, optional, slot, type CommandSpec } from '../../spec/types';

/** `STATS [aggregation, ...] [BY grouping, ...]` */
export const statsSpec: CommandSpec = [
  optional(
    slot(
      'aggregations',
      { kind: 'expression', mode: 'aggregation', computes: true },
      { list: true }
    )
  ),
  optional(
    keyword('BY'),
    slot('grouping', { kind: 'expression', mode: 'grouping', computes: true }, { list: true })
  ),
];
