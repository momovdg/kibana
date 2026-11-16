/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/** An argument that gets its suggestions from its own provider, until the engine covers it. */
export interface ProviderOverride {
  /** The team that owns the override. */
  readonly owner: string;
  /** The issue that tracks its removal. */
  readonly issue: string;
  /** What the engine or the command signatures need before the override can go. */
  readonly waitingFor: string;
}

/** The provider overrides, by argument id. */
export const PROVIDER_OVERRIDES: Readonly<Record<string, ProviderOverride>> = {
  // The query of the command is in another language, and its grammar rule takes any token: at
  // the cursor a parameter of the command cannot be told from the start of the query.
  'promqlCommand>promqlQueryPart': {
    owner: '@elastic/kibana-esql',
    issue: 'To be filed before the new flow is switched on (plan step E7)',
    waitingFor:
      'A grammar that separates the parameters of the command from its query, or a locator that keeps every reading of a token; then the sublanguage provider',
  },
};
