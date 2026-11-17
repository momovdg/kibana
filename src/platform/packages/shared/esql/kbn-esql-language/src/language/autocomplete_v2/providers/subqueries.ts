/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { esqlCommandRegistry } from '../../../commands/registry';
import { buildSubqueryCompleteItems } from '../../../commands/registry/complete_items';
import type { ISuggestionItem } from '../../../commands/registry/types';

/** The commands a subquery can start with, as the registry marks them. */
export const getSubquerySources = (): string[] =>
  esqlCommandRegistry.getAllCommands({ isStartingSubquery: true }).map(({ name }) => name);

/**
 * The openings of a subquery as items, one per command a subquery can start with. The
 * commands other than `current` come with a preview: a subquery that starts as the command
 * around it does needs none.
 */
export const buildSubqueryOpeners = (current?: string): ISuggestionItem[] =>
  buildSubqueryCompleteItems({
    previewCommands: getSubquerySources().filter((name) => name !== current),
  });
