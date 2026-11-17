/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { isFunctionExpression, Walker } from '@elastic/esql';
import { getExpressionType } from '../../../commands/definitions/utils';
import { buildExpressionFunctionParameterContext } from '../../../commands/definitions/utils/autocomplete/expressions/utils';
import type { SuggestForExpressionParams } from '../../../commands/definitions/utils/autocomplete/expressions/types';
import { isExpressionComplete } from '../../../commands/definitions/utils/expressions';
import { getUnmappedFieldsStrategy } from '../../../commands/definitions/utils/settings';
import type { ESQLColumnData, ICommandContext } from '../../../commands/registry/types';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import { enhanceWithFunctionsContext } from '../../autocomplete/get_command_context';
import { getAutocompleteCursorContext } from '../../shared/parse_for_autocomplete_query';
import type { SuggestionContext, SuggestionRequest } from '../types';
import { getItems, isLoneColumn, unquoted } from '../written';
import { getBuilderCallbacks, getLambdaColumns, getRoleColumns } from './columns';
import { getFunctionsToIgnore, locationOf, readsColumnsHere } from './functions';
import { getLambdas, type LambdaState } from './lambdas';
import { findExpressionRoot } from './tree';
import type { TypeLookup } from './types';

/**
 * What the rules and the item builders are given for the expression at the cursor: the types
 * of what is written, and the role and the editor in the terms the builders take.
 */
export interface ExpressionEnvironment extends TypeLookup {
  request: SuggestForExpressionParams;
  /** Something of the expression is written. */
  isStarted: boolean;
  /** What is written can stand as a whole expression. */
  isComplete: boolean;
  readsColumns: boolean;
  /** The columns that are an item of the list on their own, where each is listed once. */
  listedColumns: string[];
}

/** The columns that are an item of the list on their own, as `a` and not `a + 1`. */
const getListedColumns = ({ written }: CursorIR, entry: string): string[] =>
  getItems(written, entry)
    .filter(isLoneColumn)
    .map(([column]) => unquoted(column.text));

/**
 * Where the expression at the cursor starts, when part of it is written: the start of the
 * place the last written thing belongs to, or of the word being typed.
 */
const getWrittenStart = (ir: CursorIR, entry: string): number | undefined =>
  ir.written.at(-1)?.ancestors.find(({ id }) => id === entry)?.start ?? ir.word?.start;

/**
 * Reads the command once for the types of what is written, and gathers the columns and the
 * functions that apply. Nothing when the command is not one an expression can be read in.
 */
export const readExpression = async (
  { role, resolved, entry }: Extract<SuggestionRequest, { kind: 'expression' }>,
  lambda: LambdaState | undefined,
  context: SuggestionContext
): Promise<ExpressionEnvironment | undefined> => {
  const { offset, ir, callbacks } = context;
  // The body of a lambda is the value of the argument: the type lookup reads it as that once
  // the parameters and the arrow before it are blanked out.
  const lambdas = getLambdas(ir);
  const text = lambdas.reduce(
    (blanked, { head: { start, end } }) =>
      `${blanked.slice(0, start)}${' '.repeat(end - start)}${blanked.slice(end)}`,
    context.text
  );
  const { root, astContext } = getAutocompleteCursorContext(text, offset);

  if (astContext.type !== 'expression') {
    return undefined;
  }

  const { command, isCursorInSubquery } = astContext;
  const expressionRoot = findExpressionRoot(command, getWrittenStart(ir, entry));
  const canBrowseFields = (await callbacks?.canSuggestResourceBrowser?.()) ?? false;
  const columns = await context.getColumnMap();
  // Every parameter has a type for what is written with it; only the lambdas around the cursor
  // offer theirs.
  const typed = getLambdaColumns(
    lambdas.flatMap((written) => written.parameters),
    command,
    columns
  );
  const inScope = lambda?.kind === 'body' ? lambda.parameters.map(({ name }) => name) : [];
  const unmappedFieldsStrategy = getUnmappedFieldsStrategy(root.header);
  const roleColumns = await getRoleColumns(role, context, columns, unmappedFieldsStrategy);
  const commandContext: ICommandContext = {
    columns: new Map([
      ...columns,
      ...[...typed, ...roleColumns.defined].map((column): [string, ESQLColumnData] => [
        column.name,
        column,
      ]),
    ]),
    activeProduct: context.activeProduct,
    isCursorInSubquery,
    isFieldsBrowserEnabled: canBrowseFields && !isCursorInSubquery,
    unmappedFieldsStrategy,
    isTimeseriesSource: context.sourceIsTimeSeries,
  };
  const fullContext = {
    ...commandContext,
    ...(await enhanceWithFunctionsContext(command, commandContext, callbacks)),
  };
  const readsColumns = readsColumnsHere(role, ir);
  const listedColumns = role.unique ? getListedColumns(ir, entry) : [];
  const typeOfNode = (node: ReturnType<typeof findExpressionRoot>) =>
    getExpressionType(
      node,
      fullContext.columns,
      fullContext.unmappedFieldsStrategy,
      fullContext.isTimeseriesSource === true
    );
  const expressionType = typeOfNode(expressionRoot);

  return {
    request: {
      query: text,
      expressionRoot,
      command,
      cursorPosition: offset,
      location: locationOf(role, resolved, context),
      context: fullContext,
      callbacks: getBuilderCallbacks(
        typed.filter(({ name }) => inScope.includes(name)),
        roleColumns,
        readsColumns,
        context
      ),
      options: {
        ...(role.types && { preferredExpressionType: [...role.types] }),
        ...(role.subqueries && { allowSubquery: true }),
        ...(role.unique && { ignoredColumnsForEmptyExpression: listedColumns }),
        ...(!readsColumns && { suggestFields: false }),
        getFunctionsToIgnore: getFunctionsToIgnore(role, ir, entry),
      },
    },
    isStarted: expressionRoot !== undefined,
    isComplete: isExpressionComplete(expressionType, text.slice(0, offset)),
    readsColumns,
    listedColumns,
    expressionType,
    typeOf: ({ start, end }) => typeOfNode(findExpressionRoot(command, start, end)),
    // The grammar says which call the cursor is in; the node of that call gives the types of
    // the arguments written in it.
    getParameter: ({ start, name }, startsArgument) => {
      const call = Walker.find(
        command,
        (node) =>
          isFunctionExpression(node) &&
          node.location.min === start &&
          (name === undefined || node.name === name)
      );

      return call && isFunctionExpression(call)
        ? buildExpressionFunctionParameterContext(call, fullContext, startsArgument)
        : null;
    },
  };
};
