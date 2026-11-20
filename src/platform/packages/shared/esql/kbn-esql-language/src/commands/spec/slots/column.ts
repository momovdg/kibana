/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { withAutoSuggest } from '../../definitions/utils/autocomplete/helpers';
import {
  commaCompleteItem,
  newLineCompleteItem,
  pipeCompleteItem,
} from '../../registry/complete_items';
import type { ISuggestionItem } from '../../registry/types';
import type { OfferContext } from '../offer';
import type { ColumnSlot } from '../types';

const unquoted = (name: string): string => name.replace(/`/g, '');

/**
 * What can follow a column of a list, offered with the columns: the editor shows these once
 * what is typed is a whole column, so one choice ends the name and goes on.
 */
const getFollowUps = (canListMore: boolean): ISuggestionItem[] =>
  [
    newLineCompleteItem,
    { ...pipeCompleteItem, text: ' | ' },
    ...(canListMore ? [withAutoSuggest({ ...commaCompleteItem, text: ', ' })] : []),
  ].map((item) => ({ ...item, preserveTypedPrefix: true, requiresExistingColumnMatch: true }));

/**
 * The columns of the query so far. One on its own is followed by a space, and the suggestions
 * open again. In a list, the columns already listed are left out where each is listed once.
 */
export const offerColumns = async (
  { list, unique }: ColumnSlot,
  listed: string[],
  { callbacks, typed }: OfferContext
): Promise<ISuggestionItem[]> => {
  if (!list) {
    return (
      (await callbacks?.getByType?.('any', undefined, {
        advanceCursor: true,
        openSuggestions: true,
      })) ?? []
    );
  }

  const used = unique ? [...listed, typed].filter(Boolean).map(unquoted) : [];
  const columns = (await callbacks?.getByType?.('any', used)) ?? [];

  return [...getFollowUps(columns.length > 0), ...columns.map((column) => withAutoSuggest(column))];
};
