/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { defaultLimitValueSuggestions } from '../../commands/registry/complete_items';
import { UnmappedFieldsStrategy } from '../../commands/registry/types';
import type { CallSiteId } from '../../esql_js_sim/definitions';

/**
 * What the editor shows beyond what the language says, by the place of an argument. This is
 * data about presentation only: a place is named by its call site in the grammar, never by a
 * command, and nothing here decides what is valid.
 *
 * The tables that hold values of other modules are functions: this package has import cycles
 * through its entry, so a module may be loaded before the modules it imports are ready, and
 * nothing of another module may be read while this one loads.
 */

/**
 * Values worth offering where any value of a type is valid: the language allows every number
 * as a limit, the editor offers a few common ones.
 */
export const getSuggestedValues = (): Readonly<Record<CallSiteId, readonly string[]>> => ({
  'limitCommand>constant': defaultLimitValueSuggestions,
  'mmrCommand.limitValue': defaultLimitValueSuggestions,
});

/**
 * Values worth offering for the value of a name, by the place of the value and by the name:
 * the common values of a setting that takes any string.
 */
export const getSuggestedValuesByName = (): Readonly<
  Record<CallSiteId, Readonly<Record<string, readonly string[]>>>
> => ({
  'setField>constant': {
    project_routing: ['_alias:*', '_alias:_origin'],
    unmapped_fields: Object.values(UnmappedFieldsStrategy),
  },
});

/**
 * Where the editor offers ready-made next steps of a query once the sources are written, by
 * the place of the list of sources. `with_templates`: the editor's own queries and the
 * static ones; `from_the_editor`: only the editor's, where the static ones do not apply.
 */
export const RECOMMENDED_QUERIES: Readonly<
  Record<CallSiteId, 'with_templates' | 'from_the_editor'>
> = {
  'fromCommand>indexPatternAndMetadataFields': 'with_templates',
  'timeSeriesCommand>indexPatternAndMetadataFields': 'from_the_editor',
};
