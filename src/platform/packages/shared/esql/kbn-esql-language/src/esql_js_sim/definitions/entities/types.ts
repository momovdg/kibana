/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EntityType } from '../signatures/types';

/** What the language says about a kind of entity. */
export interface EntityFacts {
  /** The entity that has the values, for one that belongs to another: the policy of a field. */
  parent?: EntityType;
  /** Words that may come before a name, joined to it by a colon, as `_any:policy`. */
  qualifiers?: readonly string[];
}
