/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { keyword, optional, repeat, slot, symbol, type CommandSpec } from '../../spec/types';

/** `STATS [[name =] aggregation [WHERE filter], ...] [BY [name =] grouping, ...]` */
export const statsSpec: CommandSpec = [
  optional(
    repeat(
      optional(slot('name', { kind: 'new_name', of: 'column' }), symbol('=')),
      slot('aggregation', { kind: 'expression', mode: 'aggregation', computes: true }),
      optional(
        keyword('WHERE'),
        slot('filter', {
          kind: 'expression',
          mode: 'filter',
          types: ['boolean'],
          completeAs: 'boolean',
          subqueries: true,
        })
      )
    )
  ),
  optional(
    keyword('BY'),
    repeat(
      optional(slot('groupName', { kind: 'new_name', of: 'column' }), symbol('=')),
      slot('grouping', { kind: 'expression', mode: 'grouping', unique: true })
    )
  ),
];
