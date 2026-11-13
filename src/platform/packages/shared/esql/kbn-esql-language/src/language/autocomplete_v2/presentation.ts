/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { defaultLimitValueSuggestions } from '../../commands/registry/complete_items';
import type { CallSiteId } from '../../esql_js_sim/definitions';

/**
 * What the editor shows beyond what the language says, by the place of an argument. This is
 * data about presentation only: a place is named by its call site in the grammar, never by a
 * command, and nothing here decides what is valid.
 */

/**
 * Values worth offering where any value of a type is valid: the language allows every number
 * as a limit, the editor offers a few common ones.
 */
export const SUGGESTED_VALUES: Readonly<Record<CallSiteId, readonly string[]>> = {
  'limitCommand>constant': defaultLimitValueSuggestions,
  'mmrCommand.limitValue': defaultLimitValueSuggestions,
};
