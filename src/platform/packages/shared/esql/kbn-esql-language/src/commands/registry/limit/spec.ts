/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { keyword, listOf, optional, slot, type CommandSpec } from '../../spec/types';
import { Location } from '../types';

/** `LIMIT max_number_of_rows [BY grouping_expression1[, ..., grouping_expressionN]]` */
export const limitSpec: CommandSpec = [
  slot('constant', { suggestedValues: ['10', '100', '1000'] }),
  optional(
    keyword('BY'),
    listOf(slot('expression', { functions: Location.LIMIT_BY, unique: true }))
  ),
];
