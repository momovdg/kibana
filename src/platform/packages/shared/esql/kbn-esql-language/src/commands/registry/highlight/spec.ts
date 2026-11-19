/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { ARGUMENT_ROLES } from '../../../esql_js_sim/definitions';
import { keyword, optional, slot, symbol, word, type CommandSpec } from '../../spec/types';

const STRING_TYPES = ['keyword', 'text'];

/** `HIGHLIGHT [prefix = "<prefix>"] [<query>] [ON field, ... | ON *] [WITH { <options> }]` */
export const highlightSpec: CommandSpec = [
  optional(
    word('prefix'),
    symbol('='),
    slot('prefix', { kind: 'constant', valueType: 'string', default: 'highlight_' })
  ),
  optional(
    slot(
      'query',
      { kind: 'expression', mode: 'full_text', types: ['boolean'] },
      { placeholder: 'The text to highlight' }
    )
  ),
  optional(
    keyword('ON'),
    slot('fields', { kind: 'column', types: STRING_TYPES, wildcard: 'alone' }, { list: true })
  ),
  optional(
    keyword('WITH'),
    slot('options', ARGUMENT_ROLES['highlightCommand>commandNamedParameters'])
  ),
];
