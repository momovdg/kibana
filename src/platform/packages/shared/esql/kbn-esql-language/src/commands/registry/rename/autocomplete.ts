/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLAstAllCommands } from '@elastic/esql/types';
import type { ICommandCallbacks } from '../types';
import { type ISuggestionItem, type ICommandContext } from '../types';
import {
  newLineAndPipeCompleteItems,
  asCompletionItem,
  assignCompletionItem,
  commaCompleteItem,
  getNewUserDefinedColumnSuggestion,
} from '../complete_items';
import { columnExists } from '../../definitions/utils/autocomplete/helpers';
import { locateCursor } from '../../../language/shared/cursor_location/cursor_location';
import { getFirstName, getPosition, RenamePosition } from './utils';

export async function autocomplete(
  query: string,
  command: ESQLAstAllCommands,
  callbacks?: ICommandCallbacks,
  context?: ICommandContext,
  cursorPosition?: number
): Promise<ISuggestionItem[]> {
  const location = context?.cursorLocation ?? locateCursor(query, cursorPosition ?? query.length);

  const getColumnSuggestions = async () =>
    (await callbacks?.getByType?.('any', [], {
      advanceCursor: true,
      openSuggestions: true,
    })) ?? [];

  switch (getPosition(location)) {
    case RenamePosition.TYPING_AS:
      return [asCompletionItem];

    // An existing column is renamed with AS; an unknown name is a new name assigned with `=`.
    case RenamePosition.AFTER_FIRST_NAME:
      return columnExists(getFirstName(location), context)
        ? [asCompletionItem]
        : [assignCompletionItem];

    case RenamePosition.AFTER_CLAUSE:
      return [...newLineAndPipeCompleteItems, { ...commaCompleteItem, text: ', ' }];

    case RenamePosition.AFTER_AS:
      return [];

    case RenamePosition.AFTER_ASSIGN:
      return getColumnSuggestions();

    case RenamePosition.NAME:
      return [
        ...(await getColumnSuggestions()),
        getNewUserDefinedColumnSuggestion(callbacks?.getSuggestedUserDefinedColumnName?.() || ''),
      ];
  }
}
