/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { withAutoSuggest } from '../../../definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from '../../types';
import { SuggestionCategory } from '../../../../language/autocomplete/utils/sorting/types';
import { matchesWildcardPattern } from '../../../definitions/utils/regex';

export const METADATA_FIELDS = [
  '_version',
  '_id',
  '_index',
  '_source',
  '_ignored',
  '_index_mode',
  '_score',
  '_size',
  '_slice',
  '_name',
  '_class',
];

export const CPS_METADATA_FIELDS = [
  '_project._id',
  '_project._alias',
  '_project._type',
  '_project._organization',
  '_project._csp',
  '_project._region',
];

const PROJECT_TAG_PREFIX = '_project.';

export const getAvailableMetadataFields = (isServerless?: boolean): string[] =>
  isServerless ? [...METADATA_FIELDS, ...CPS_METADATA_FIELDS] : METADATA_FIELDS;

export const isValidMetadataField = (name: string, isServerless?: boolean): boolean => {
  const availableFields = getAvailableMetadataFields(isServerless);
  if (availableFields.includes(name)) {
    return true;
  }
  if (isServerless && name.startsWith(PROJECT_TAG_PREFIX)) {
    return true;
  }
  return name.includes('*') && availableFields.some((field) => matchesWildcardPattern(name, field));
};

export const metadataSuggestion: ISuggestionItem = withAutoSuggest({
  label: 'METADATA',
  text: 'METADATA ',
  kind: 'Reference',
  detail: i18n.translate('esqlLanguage.esql.definitions.metadataDoc', {
    defaultMessage: 'Metadata',
  }),
  category: SuggestionCategory.VALUE,
});
