/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { withAutoSuggest } from '../../definitions/utils/autocomplete/helpers';

/** The SORT modifiers, also the keyword items for `ASC`, `DESC` and `NULLS`. */
export const sortModifierSuggestions = {
  ASC: withAutoSuggest({
    label: 'ASC',
    text: 'ASC',
    detail: '',
    kind: 'Keyword',
  }),
  DESC: withAutoSuggest({
    label: 'DESC',
    text: 'DESC',
    detail: '',
    kind: 'Keyword',
  }),
  NULLS_FIRST: withAutoSuggest({
    label: 'NULLS FIRST',
    text: 'NULLS FIRST',
    detail: '',
    kind: 'Keyword',
  }),
  NULLS_LAST: withAutoSuggest({
    label: 'NULLS LAST',
    text: 'NULLS LAST',
    detail: '',
    kind: 'Keyword',
  }),
};
