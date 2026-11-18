/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { keyword, optional, repeat, slot, symbol, type CommandSpec } from '../../spec/types';

/** `ENRICH policy [ON match_field] [WITH [new_name =] enrich_field, ...]` */
export const enrichSpec: CommandSpec = [
  slot('policy', { kind: 'entity', entityType: 'enrich_policy' }),
  optional(keyword('ON'), slot('matchField', { kind: 'column' })),
  optional(
    keyword('WITH'),
    repeat(
      optional(slot('newName', { kind: 'new_name', of: 'column' }), symbol('=')),
      slot('enrichField', { kind: 'entity', entityType: 'enrich_field' })
    )
  ),
];
