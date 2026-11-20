/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLAstAllCommands } from '@elastic/esql/types';
import { commaCompleteItem, newLineAndPipeCompleteItems } from '../registry/complete_items';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem } from '../registry/types';
import { buildKeywordItem } from './keyword';
import type { Expected } from './reading';
import { offerColumns } from './slots/column';
import { offerConstants } from './slots/constant';
import { offerExpressions } from './slots/expression';

/** What an offer can read: the query and its command, what the editor knows, the cursor. */
export interface OfferContext {
  query: string;
  command: ESQLAstAllCommands;
  callbacks?: ICommandCallbacks;
  context?: ICommandContext;
  cursorPosition: number;
  /** What is being typed at the cursor. */
  typed: string;
}

type Offer = Promise<ISuggestionItem[]> | ISuggestionItem[];

const offerSlot = (
  { slot, listed, after }: Extract<Expected, { kind: 'slot' }>,
  context: OfferContext
): Offer => {
  switch (slot.role) {
    case 'column':
      return offerColumns(slot, listed, context);
    case 'constant':
      return offerConstants(slot);
    case 'expression':
      return offerExpressions(slot, after, context);
  }
};

/** The suggestions for one thing the spec allows at the cursor, by what kind of thing it is. */
export const offer = (expected: Expected, context: OfferContext): Offer => {
  switch (expected.kind) {
    case 'slot':
      return offerSlot(expected, context);
    case 'keyword':
      return [buildKeywordItem(expected.text)];
    case 'separator':
      return [commaCompleteItem];
    case 'end':
      return newLineAndPipeCompleteItems;
  }
};
