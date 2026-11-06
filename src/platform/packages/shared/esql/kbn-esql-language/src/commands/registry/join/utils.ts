/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import type { ESQLFieldWithMetadata } from '@kbn/esql-types';
import { isOptionNode } from '@elastic/esql';
import type { ESQLAstJoinCommand, ESQLCommand, ESQLCommandOption } from '@elastic/esql/types';
import { buildFieldsDefinitionsWithMetadata } from '../../definitions/utils';
import type { GetColumnsByTypeFn, ICommandContext, ISuggestionItem } from '../types';
import { SuggestionCategory } from '../../../language/autocomplete/utils/sorting/types';
import { getLookupJoinSource } from '../../definitions/utils/sources';

export const getLookupFields = async (
  command: ESQLCommand,
  getColumnsForQuery: (query: string) => Promise<ESQLFieldWithMetadata[]>,
  context?: ICommandContext
): Promise<ESQLFieldWithMetadata[]> => {
  if (!context) {
    return [];
  }
  const joinTarget = getLookupJoinSource(command as ESQLAstJoinCommand);
  return getColumnsForQuery(`FROM ${joinTarget}`);
};

export const getOnOption = (command: ESQLAstJoinCommand): ESQLCommandOption | undefined => {
  return command.args?.find((arg) => isOptionNode(arg) && arg.name === 'on') as
    | ESQLCommandOption
    | undefined;
};

/**
 * Identifies common fields between source and lookup suggestions and marks them appropriately.
 * Common fields are those that exist in both source and lookup with the same label.

 */
export const markCommonFields = (
  sourceSuggestions: ISuggestionItem[],
  lookupSuggestions: ISuggestionItem[]
): {
  markedSourceSuggestions: ISuggestionItem[];
  uniqueLookupSuggestions: ISuggestionItem[];
  commonFieldLabels: Set<string>;
} => {
  const sourceLabels = new Set(sourceSuggestions.map(({ label }) => label));
  const commonFieldLabels = new Set(
    lookupSuggestions.map(({ label }) => label).filter((label) => sourceLabels.has(label))
  );

  // Mark common fields in source suggestions
  const markedSourceSuggestions = sourceSuggestions.map((suggestion) => {
    if (commonFieldLabels.has(suggestion.label)) {
      let detail = suggestion.detail || '';

      if (detail) {
        detail += ' ';
      }

      detail += i18n.translate('esqlLanguage.esql.autocomplete.join.commonFieldNote', {
        defaultMessage: '(common field)',
      });

      return {
        ...suggestion,
        detail,
        category: SuggestionCategory.LOOKUP_COMMON_FIELD,
        documentation: {
          value: i18n.translate('esqlLanguage.esql.autocomplete.join.sharedField', {
            defaultMessage: 'Field shared between the source and the lookup index',
          }),
        },
      };
    }

    return suggestion;
  });

  // Filter out duplicate lookup fields
  const uniqueLookupSuggestions = lookupSuggestions.filter(
    ({ label }) => !commonFieldLabels.has(label)
  );

  return {
    markedSourceSuggestions,
    uniqueLookupSuggestions,
    commonFieldLabels,
  };
};

/** Creates an enriched context that includes lookup table fields in the columns map. */
export const createEnrichedContext = async (
  originalContext: ICommandContext | undefined,
  joinCommand: ESQLAstJoinCommand,
  getColumnsForQuery: (query: string) => Promise<ESQLFieldWithMetadata[]>
): Promise<ICommandContext | undefined> => {
  if (!originalContext) {
    return undefined;
  }

  const lookupFields = await getLookupFields(joinCommand, getColumnsForQuery, originalContext);
  const enrichedColumns = new Map(originalContext.columns);

  for (const field of lookupFields) {
    if (!enrichedColumns.has(field.name)) {
      enrichedColumns.set(field.name, field);
    }
  }

  return {
    ...originalContext,
    columns: enrichedColumns,
  };
};

/**
 * Creates an enriched getByType function that includes lookup table fields
 * in addition to the source table fields.
 */
export const createEnrichedGetByType = async (
  originalGetByType: GetColumnsByTypeFn,
  joinCommand: ESQLAstJoinCommand,
  getColumnsForQuery: (query: string) => Promise<ESQLFieldWithMetadata[]>,
  context?: ICommandContext
): Promise<GetColumnsByTypeFn> => {
  const lookupFields = await getLookupFields(joinCommand, getColumnsForQuery, context);

  // Return wrapper function
  return async (type: Readonly<string> | Readonly<string[]>, ignored?: string[], options?: any) => {
    const sourceColumns = await originalGetByType(type, ignored, options);
    const types = Array.isArray(type) ? type : [type];
    const filteredLookupFields = lookupFields.filter(({ name, type: t }) => {
      return !ignored?.includes(name) && (types[0] === 'any' || types.includes(t));
    });

    const lookupSuggestions = buildFieldsDefinitionsWithMetadata(
      filteredLookupFields,
      [],
      options,
      context?.variables
    );

    // Use the utility function to mark common fields
    const { markedSourceSuggestions, uniqueLookupSuggestions } = markCommonFields(
      sourceColumns,
      lookupSuggestions
    );

    return [...markedSourceSuggestions, ...uniqueLookupSuggestions];
  };
};
