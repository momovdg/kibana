/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { ESQL_NUMBER_TYPES } from '../../definitions/types';
import { keyword, optional, slot, symbol, type CommandSpec } from '../../spec/types';

/** `CHANGE_POINT value [ON key] [AS type, pvalue] [BY grouping, ...]` */
export const changePointSpec: CommandSpec = [
  slot('value', { kind: 'column', types: [...ESQL_NUMBER_TYPES] }),
  optional(keyword('ON'), slot('key', { kind: 'column' })),
  optional(
    keyword('AS'),
    slot('type', { kind: 'new_name', of: 'column' }, { suggestedName: 'changePointType' }),
    symbol(','),
    slot('pvalue', { kind: 'new_name', of: 'column' }, { suggestedName: 'pValue' })
  ),
  optional(
    keyword('BY'),
    slot('grouping', { kind: 'expression', mode: 'key', unique: true }, { list: true })
  ),
];
