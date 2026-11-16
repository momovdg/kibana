/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { i18n } from '@kbn/i18n';
import {
  defaultLimitValueSuggestions,
  mmrQueryVectorSuggestion,
} from '../../commands/registry/complete_items';
import { UnmappedFieldsStrategy, type ISuggestionItem } from '../../commands/registry/types';
import type { CallSiteId, EntityType, ValueFormat } from '../../esql_js_sim/definitions';
import { SuggestionCategory } from '../autocomplete/utils/sorting/types';

/**
 * What the editor shows beyond what the language says, by the place of an argument. This is
 * data about presentation only: a place is named by its call site in the grammar, never by a
 * command, and nothing here decides what is valid.
 *
 * The tables that hold values of other modules are functions: this package has import cycles
 * through its entry, so a module may be loaded before the modules it imports are ready, and
 * nothing of another module may be read while this one loads.
 */

/** Values the editor offers at a place, with what the item says about them. */
export interface SuggestedValues {
  values: readonly string[];
  detail?: string;
}

const getPatternDetail = (): string =>
  i18n.translate('esqlLanguage.esql.autocomplete.aPatternString', {
    defaultMessage: 'A pattern string',
  });

/**
 * Values worth offering where any value of a type is valid: the language allows every number
 * as a limit and every string as a pattern, the editor offers a few common ones.
 */
export const getSuggestedValues = (): Readonly<Record<CallSiteId, SuggestedValues>> => ({
  'limitCommand>constant': { values: defaultLimitValueSuggestions },
  'mmrCommand.limitValue': { values: defaultLimitValueSuggestions },
  'sampleCommand.probability': { values: ['.1', '.01', '.001'] },
  'dissectCommand>string': { values: ['"%{firstWord}"'], detail: getPatternDetail() },
  'dissectCommandOption>constant': { values: ['":"', '";"'] },
  'grokCommand>string': { values: ['"%{WORD:firstWord}"'], detail: getPatternDetail() },
});

/**
 * A ready-made string the editor offers where a value has a known use, by that use: the
 * string is selected once inserted, so typing replaces it.
 */
const getValuePlaceholders = (): Readonly<Partial<Record<ValueFormat, string>>> => ({
  llm_prompt: 'Your prompt to the LLM.',
  search_query: 'Your search query',
  highlight_text: i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.queryTextPlaceholder',
    { defaultMessage: 'The text to highlight' }
  ),
});

/** The item for the ready-made string of a use, when the editor has one. */
export const getValueSnippet = (format: ValueFormat | undefined): ISuggestionItem[] => {
  const placeholder = format === undefined ? undefined : getValuePlaceholders()[format];

  return placeholder === undefined
    ? []
    : [
        {
          label: placeholder,
          text: `"\${0:${placeholder}}"`,
          asSnippet: true,
          kind: 'Constant',
          detail: '',
          category: SuggestionCategory.CONSTANT_VALUE,
        },
      ];
};

/** A ready-made value the editor offers where an expression starts, by its place. */
export const getStartingValues = (): Readonly<Record<CallSiteId, ISuggestionItem>> => ({
  'mmrCommand.queryVector': mmrQueryVectorSuggestion,
});

/**
 * The parameter a map is opened with, by the place of the map: the one a query usually
 * gives. A map with one parameter is opened with that one and needs no entry.
 */
export const OPENING_PARAMETERS: Readonly<Record<CallSiteId, string>> = {
  'denseVectorCommand>commandNamedParameters': 'inference_id',
};

/** What the editor says about the words that can come before a name of a kind of entity. */
export const getQualifierDetail = (entityType: EntityType): string | undefined =>
  entityType === 'enrich_policy'
    ? i18n.translate('esqlLanguage.esql.definitions.ccqMode', {
        defaultMessage: 'Cross-cluster query mode',
      })
    : undefined;

/**
 * The name the editor offers for a new column where the language takes any name, by the
 * place of the name.
 */
export const SUGGESTED_NAMES: Readonly<Record<CallSiteId, string>> = {
  'changePointCommand.targetType': 'changePointType',
  'changePointCommand.targetPvalue': 'pValue',
};

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
