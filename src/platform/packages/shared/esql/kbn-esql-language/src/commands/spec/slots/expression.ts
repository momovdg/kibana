/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isColumn, isOptionNode } from '@elastic/esql';
import type { ESQLAstAllCommands, ESQLAstField } from '@elastic/esql/types';
import { suggestFieldsList } from '../../definitions/utils/autocomplete/fields_list';
import type { ISuggestionItem } from '../../registry/types';
import type { OfferContext } from '../offer';
import type { ExpressionSlot, Keyword } from '../types';

/**
 * The expressions already written: what the command has after the keyword, or all it has
 * where the expressions come first. None where the keyword is not in the command as parsed.
 */
const readWritten = (
  { args }: ESQLAstAllCommands,
  after: Keyword | undefined
): ESQLAstField[] | undefined => {
  if (!after) {
    return args as ESQLAstField[];
  }

  const option = args.find((arg) => isOptionNode(arg) && arg.name === after.toLowerCase());

  return option && isOptionNode(option) ? (option.args as ESQLAstField[]) : undefined;
};

const columnsOf = (expressions: ESQLAstField[]): string[] =>
  expressions.filter(isColumn).map(({ parts }) => parts.join('.'));

/**
 * What starts or continues an expression of a list, and once one is whole, what follows it:
 * the comma, and the end of the command. The code the commands share for expressions
 * decides all of it.
 */
export const offerExpressions = async (
  { functions, unique }: ExpressionSlot,
  after: Keyword | undefined,
  { query, command, callbacks, context, cursorPosition }: OfferContext
): Promise<ISuggestionItem[]> => {
  const written = readWritten(command, after);

  if (!written) {
    return [];
  }

  return suggestFieldsList(query, command, written, functions, callbacks, context, cursorPosition, {
    ignoredColumnsForEmptyExpression: unique ? columnsOf(written) : [],
    allowSingleColumnFields: true,
    disableNewColumnSuggestion: true,
  });
};
