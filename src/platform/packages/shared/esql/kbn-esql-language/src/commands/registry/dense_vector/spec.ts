/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { ARGUMENT_ROLES } from '../../../esql_js_sim/definitions';
import { choice, keyword, optional, slot, symbol, word, type CommandSpec } from '../../spec/types';

const STRING_TYPES = ['keyword', 'text'];
const fields = slot('fields', { kind: 'column', types: STRING_TYPES }, { list: true });

/**
 * `DENSE_VECTOR field, ...`, `DENSE_VECTOR target = field` or
 * `DENSE_VECTOR suffix = "<suffix>" ON field, ...`, each with `[WITH { <options> }]`
 */
export const denseVectorSpec: CommandSpec = [
  choice(
    [
      word('suffix'),
      symbol('='),
      slot('suffix', { kind: 'constant', valueType: 'string', default: '_dense_vector' }),
      keyword('ON'),
      fields,
    ],
    [
      slot('target', { kind: 'new_name', of: 'column' }),
      symbol('='),
      slot('field', { kind: 'column', types: STRING_TYPES }),
    ],
    [fields]
  ),
  optional(
    keyword('WITH'),
    slot('options', ARGUMENT_ROLES['denseVectorCommand>commandNamedParameters'], {
      opensWith: 'inference_id',
    })
  ),
];
