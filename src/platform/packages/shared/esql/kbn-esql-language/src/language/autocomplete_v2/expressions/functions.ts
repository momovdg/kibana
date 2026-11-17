/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { FULL_TEXT_SEARCH_DEFINITIONS } from '../../../commands/definitions/constants';
import type { ExpressionContextOptions } from '../../../commands/definitions/utils/autocomplete/expressions/types';
import {
  getAllFunctions,
  getFunctionDefinition,
} from '../../../commands/definitions/utils/functions';
import { FunctionDefinitionTypes } from '../../../commands/definitions/types';
import { Location } from '../../../commands/registry/types';
import {
  FUNCTION_CALL,
  type CallSiteId,
  type ExpressionMode,
  type ExpressionRole,
  type ResolvedRole,
} from '../../../esql_js_sim/definitions';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import type { SuggestionContext } from '../types';
import { getCurrentItem, lowerTextOf, partOf } from '../written';

/*
 * Which functions and operators apply to an expression, from its role. The function
 * definitions say where each applies in terms of their own (`Location`): this file is the
 * only place of the engine that uses those terms.
 */

/** The set a mode stands for. A function, so that nothing is read while the module loads. */
const getModeLocations = (): Readonly<Record<ExpressionMode, Location>> => ({
  scalar: Location.SORT,
  aggregation: Location.STATS,
  grouping: Location.STATS_BY,
  key: Location.LIMIT_BY,
  filter: Location.WHERE,
  constant: Location.ROW,
  full_text: Location.HIGHLIGHT_QUERY,
});

/** The cursor is between the brackets of a function call. */
const isInFunctionCall = ({ written }: CursorIR): boolean =>
  written.at(-1)?.ancestors.some(({ id, open }) => id === FUNCTION_CALL && open) ?? false;

export const locationOf = (
  role: ExpressionRole,
  { enclosing }: ResolvedRole,
  { ir, sourceIsTimeSeries }: SuggestionContext
): Location => {
  const isInAggregation = enclosing.some(
    (outer) => outer.role.kind === 'expression' && outer.role.mode === 'aggregation'
  );

  if (role.mode === 'filter' && isInAggregation) {
    return Location.STATS_WHERE;
  }
  // An aggregation over a time series takes the time-series aggregations as its arguments.
  if (role.mode === 'aggregation' && sourceIsTimeSeries && isInFunctionCall(ir)) {
    return Location.STATS_TIMESERIES;
  }
  // Where full-text functions have a place, the wider set of functions applies.
  if (role.mode === 'scalar' && role.fullTextOnlyIn) {
    return Location.EVAL;
  }

  return getModeLocations()[role.mode];
};

// The modes that read a column only as the argument of a function.
const COLUMNS_IN_CALLS_ONLY: readonly ExpressionMode[] = ['constant', 'aggregation', 'full_text'];

/** Whether a column can stand at the cursor, by the mode of the role. */
export const readsColumnsHere = (role: ExpressionRole, ir: CursorIR): boolean =>
  !COLUMNS_IN_CALLS_ONLY.includes(role.mode) || isInFunctionCall(ir);

const namesOfType = (type: FunctionDefinitionTypes): string[] =>
  getAllFunctions({ type }).map(({ name }) => name);

// The kinds of function that aggregate: one of them is not offered inside another.
const getAggregatingTypes = (): FunctionDefinitionTypes[] => [
  FunctionDefinitionTypes.AGG,
  FunctionDefinitionTypes.TIME_SERIES_AGG,
];

/**
 * The functions that are not offered for an argument of a function:
 *
 * - full-text functions, where the role allows them only inside one function;
 * - grouping functions inside a grouping function;
 * - in an aggregation, the functions already written in the item, and every aggregating
 *   function of a kind the item already has, unless the argument is declared to take one.
 */
export const getFunctionsToIgnore =
  (
    role: ExpressionRole,
    ir: CursorIR,
    entry: CallSiteId
  ): ExpressionContextOptions['getFunctionsToIgnore'] =>
  (parameter) => {
    const names: string[] = role.fullTextOnlyIn ? [...FULL_TEXT_SEARCH_DEFINITIONS] : [];
    const allowedInsideFunctions = Object.fromEntries(
      names.map((name) => [name, [role.fullTextOnlyIn ?? '']])
    );

    if (parameter?.functionDefinition?.type === FunctionDefinitionTypes.GROUPING) {
      names.push(...namesOfType(FunctionDefinitionTypes.GROUPING));
    }

    if (parameter && role.mode === 'aggregation') {
      const written = getCurrentItem(ir.written, entry)
        .filter((part) => partOf(part) === 'function_name')
        .map(lowerTextOf);
      const takesAggregation = parameter.paramDefinitions.some(
        ({ hint }) => hint?.kind === 'aggregation'
      );
      const usedKinds = getAggregatingTypes().filter((type) =>
        written.some((name) => getFunctionDefinition(name)?.type === type)
      );

      names.push(...written, ...(takesAggregation ? [] : usedKinds.flatMap(namesOfType)));
    }

    return { names, allowedInsideFunctions };
  };
