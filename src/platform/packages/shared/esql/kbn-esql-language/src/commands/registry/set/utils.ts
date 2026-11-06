/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { UnmappedFieldsStrategy, type ISuggestionItem } from '../types';
import { SuggestionCategory } from '../../../..';
import type { MapParameters } from '../../definitions/utils/autocomplete/map_expression';
import { settings } from '../../definitions/generated/settings';
import { confidenceLevelValueItems, numOfRowsValueItems } from '../complete_items';
import { parseMapParams } from '../../definitions/utils/maps';
import { Settings } from '../../definitions/keywords';

const getProjectRoutingCommonCompletionItems = (): ISuggestionItem[] => {
  return [
    {
      label: '_alias:_origin',
      text: '_alias:_origin',
      kind: 'Value',
      detail: i18n.translate(
        'esqlLanguage.esql.autocomplete.set.projectRouting.currentProjectDoc',
        {
          defaultMessage: 'Search only the current project',
        }
      ),
      category: SuggestionCategory.CONSTANT_VALUE,
    },
    {
      label: '_alias:*',
      text: '_alias:*',
      kind: 'Value',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.set.projectRouting.allProjectsDoc', {
        defaultMessage: 'Search all projects',
      }),
      category: SuggestionCategory.CONSTANT_VALUE,
    },
  ];
};

const getUnmappedFieldsCompletionItems = (): ISuggestionItem[] => {
  return [
    {
      label: UnmappedFieldsStrategy.DEFAULT,
      text: UnmappedFieldsStrategy.DEFAULT,
      kind: 'Value',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.set.unmappedFields.failDoc', {
        defaultMessage: 'Fails the query if unmapped fields are present',
      }),
      category: SuggestionCategory.CONSTANT_VALUE,
    },
    {
      label: UnmappedFieldsStrategy.NULLIFY,
      text: UnmappedFieldsStrategy.NULLIFY,
      kind: 'Value',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.set.unmappedFields.nullifyDoc', {
        defaultMessage: 'Treats unmapped fields as null values',
      }),
      category: SuggestionCategory.CONSTANT_VALUE,
    },
    {
      label: UnmappedFieldsStrategy.LOAD,
      text: UnmappedFieldsStrategy.LOAD,
      kind: 'Value',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.set.unmappedFields.loadDoc', {
        defaultMessage:
          'Attempts to load the fields from the source that are explicitly mentioned in the query',
      }),
      category: SuggestionCategory.CONSTANT_VALUE,
    },
    {
      label: UnmappedFieldsStrategy.LOAD_ALL,
      text: UnmappedFieldsStrategy.LOAD_ALL,
      kind: 'Value',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.set.unmappedFields.loadAllDoc', {
        defaultMessage:
          'Attempts to load all the fields from the source, even if they are not mentioned in the query',
      }),
      category: SuggestionCategory.CONSTANT_VALUE,
    },
  ];
};

type ApproximateSetting = (typeof settings)[0] & { mapParams: string };

/** The parameters of `approximation`'s map, with example values. */
const getApproximationMapParameters = (): MapParameters => {
  const approximateSetting = settings.find(
    (s) => s.name === Settings.APPROXIMATION
  ) as ApproximateSetting;
  const parameters: MapParameters = { ...parseMapParams(approximateSetting?.mapParams || '') };
  parameters.confidence_level.suggestions = confidenceLevelValueItems;
  parameters.rows.suggestions = numOfRowsValueItems;
  return parameters;
};

const getApproximationValueItems = (): ISuggestionItem[] => {
  return [
    {
      label: 'false',
      text: 'false',
      kind: 'Value',
      category: SuggestionCategory.VALUE,
      detail: i18n.translate(
        'esqlLanguage.esql.autocomplete.set.approximate.disallowApproximateResults',
        {
          defaultMessage: 'Default - do not approximate results',
        }
      ),
    },
    {
      label: 'true',
      text: 'true',
      kind: 'Value',
      category: SuggestionCategory.VALUE,
      detail: i18n.translate(
        'esqlLanguage.esql.autocomplete.set.approximate.allowApproximateResults',
        {
          defaultMessage: 'Allow approximate results',
        }
      ),
    },
    {
      label: i18n.translate(
        'esqlLanguage.esql.autocomplete.set.approximate.approximateWithParameters',
        {
          defaultMessage: 'Approximate with parameters',
        }
      ),
      text: '{ $0 }',
      asSnippet: true,
      kind: 'Reference',
      detail: i18n.translate(
        'esqlLanguage.esql.autocomplete.set.approximate.approximateWithParameters',
        {
          defaultMessage: 'Approximate results based on parameters',
        }
      ),
    },
  ];
};

const VALUE_ITEMS_BY_SETTING_NAME: Readonly<Record<string, () => ISuggestionItem[]>> = {
  [Settings.PROJECT_ROUTING]: getProjectRoutingCommonCompletionItems,
  [Settings.UNMAPPED_FIELDS]: getUnmappedFieldsCompletionItems,
  [Settings.APPROXIMATION]: getApproximationValueItems,
};

const MAP_PARAMETERS_BY_SETTING_NAME: Readonly<Record<string, () => MapParameters>> = {
  [Settings.APPROXIMATION]: getApproximationMapParameters,
};

/** The values the editor offers for a setting, unquoted; none for an unknown setting. */
export const getSettingValueItems = (settingName: string): ISuggestionItem[] =>
  VALUE_ITEMS_BY_SETTING_NAME[settingName]?.() ?? [];

/** The parameters of a setting that takes a map, as `approximation`. */
export const getSettingMapParameters = (settingName: string): MapParameters | undefined =>
  MAP_PARAMETERS_BY_SETTING_NAME[settingName]?.();
