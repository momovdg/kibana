/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { SuggestionCategory } from '../../language/autocomplete/utils/sorting/types';
import { withAutoSuggest } from '../definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from '../registry/types';
import type { Keyword } from './types';

const capitalized = (text: string): string => `${text[0]}${text.slice(1).toLowerCase()}`;

/** A keyword as the editor offers it: followed by a space, and the suggestions open again. */
export const buildKeywordItem = (text: Keyword): ISuggestionItem =>
  withAutoSuggest({
    label: text,
    text: `${text} `,
    kind: 'Reference',
    detail: capitalized(text),
    category: SuggestionCategory.LANGUAGE_KEYWORD,
  });
