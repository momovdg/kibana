/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { commaCompleteItem, newLineAndPipeCompleteItems } from '../registry/complete_items';
import type { ICommandCallbacks, ISuggestionItem } from '../registry/types';
import type { Expected } from './match';
import { offerColumns } from './slots/column';
import { offerConstants } from './slots/constant';

/** What an offer can ask the editor, and what is being typed at the cursor. */
export interface OfferContext {
  callbacks?: ICommandCallbacks;
  typed: string;
}

/** The suggestions for one thing the spec allows at the cursor, by what kind of thing it is. */
export const offer = (
  expected: Expected,
  context: OfferContext
): Promise<ISuggestionItem[]> | ISuggestionItem[] => {
  if (expected.kind === 'end') {
    return newLineAndPipeCompleteItems;
  }
  if (expected.kind === 'separator') {
    return [commaCompleteItem];
  }

  switch (expected.slot.role) {
    case 'column':
      return offerColumns(expected.slot, expected.listed, context);
    case 'constant':
      return offerConstants(expected.slot);
  }
};
