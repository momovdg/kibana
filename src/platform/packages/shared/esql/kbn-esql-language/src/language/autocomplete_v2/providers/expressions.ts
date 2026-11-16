/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { i18n } from '@kbn/i18n';
import { isFunctionExpression, Parser, Walker } from '@elastic/esql';
import type {
  ESQLAstAllCommands,
  ESQLAstQueryExpression,
  ESQLSingleAstItem,
} from '@elastic/esql/types';
import { SuggestionCategory } from '../../autocomplete/utils/sorting/types';
import { FULL_TEXT_SEARCH_DEFINITIONS } from '../../../commands/definitions/constants';
import {
  buildFieldsDefinitionsWithMetadata,
  getExpressionType,
} from '../../../commands/definitions/utils';
import { buildExpressionFunctionParameterContext } from '../../../commands/definitions/utils/autocomplete/expressions/utils';
import type {
  ExpressionContextOptions,
  SuggestForExpressionParams,
} from '../../../commands/definitions/utils/autocomplete/expressions/types';
import {
  getAllFunctions,
  getFunctionDefinition,
} from '../../../commands/definitions/utils/functions';
import { FunctionDefinitionTypes } from '../../../commands/definitions/types';
import { isExpressionComplete } from '../../../commands/definitions/utils/expressions';
import { getUnmappedFieldsStrategy } from '../../../commands/definitions/utils/settings';
import { withAutoSuggest } from '../../../commands/definitions/utils/autocomplete/helpers';
import {
  getDateHistogramCompletionItem,
  getTimeseriesDateHistogramCompletionItem,
} from '../../../commands/registry/complete_items';
import {
  Location,
  type ESQLColumnData,
  type ICommandCallbacks,
  type ICommandContext,
  type ISuggestionItem,
} from '../../../commands/registry/types';
import {
  FUNCTION_CALL,
  type CallSiteId,
  type ExpressionMode,
  type ExpressionRole,
  type ResolvedRole,
} from '../../../esql_js_sim/definitions';
import {
  readToEndOfCommand,
  type CursorIR,
  type WrittenArgument,
} from '../../../esql_js_sim/grammar';
import { NOT_SUGGESTED_TYPES } from '../../../query_columns_service';
import { enhanceWithFunctionsContext } from '../../autocomplete/get_command_context';
import { getAutocompleteCursorContext } from '../../shared/parse_for_autocomplete_query';
import type { SuggestionContext, SuggestionRequest } from '../types';
import { getStartingValues, getValueSnippet } from '../presentation';
import { decideExpression } from './expression_decisions';
import { getDefinedNames } from './expression_names';
import { isAssignmentToken } from './tokens';
import { describeExpressionPosition } from './expression_position';
import { getLambdas, getLambdaState, type LambdaParameter, type LambdaState } from './lambdas';
import { getItems, isLoneColumn, lowerTextOf, partOf, unquoted } from '../written';

/** What the expression at the cursor offers, and whether the command can go on after it. */
export interface ExpressionSuggestions {
  /** The call site of the expression. */
  entry: CallSiteId;
  items: ISuggestionItem[];
  /** Something is written that is not yet a whole expression of the type its role asks for. */
  isUnfinished: boolean;
}

/**
 * The set of functions and operators a mode stands for, in the terms of the function
 * definitions. This table (a function, so that nothing is read while the module loads) and `locationOf` are the only place the engine uses these terms.
 */
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

const locationOf = (
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

const readsColumnsHere = (role: ExpressionRole, ir: CursorIR): boolean =>
  !COLUMNS_IN_CALLS_ONLY.includes(role.mode) || isInFunctionCall(ir);

/** The item the cursor is in: the one the last thing written belongs to. */
const getCurrentItem = ({ written }: CursorIR, entry: CallSiteId): WrittenArgument[] => {
  const last = written.at(-1);

  return (last && getItems(written, entry).find((parts) => parts.includes(last))) ?? [];
};

/** The columns that are an item of the list on their own, as `a` and not `a + 1`. */
const getListedColumns = ({ written }: CursorIR, entry: CallSiteId): string[] =>
  getItems(written, entry)
    .filter(isLoneColumn)
    .map(([column]) => unquoted(column.text));

const namesOfType = (type: FunctionDefinitionTypes): string[] =>
  getAllFunctions({ type }).map(({ name }) => name);

// The kinds of function that aggregate: one of them is not offered inside another. A
// function, so that nothing of another module is read while this one loads.
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
const getFunctionsToIgnore =
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
      const written = getCurrentItem(ir, entry)
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

/**
 * Where the expression at the cursor starts, when part of it is written: the start of the
 * place the last written thing belongs to, or of the word being typed.
 */
const getWrittenStart = (ir: CursorIR, entry: CallSiteId): number | undefined => {
  const written = ir.written.at(-1)?.ancestors.find(({ id }) => id === entry);

  return written?.start ?? ir.word?.start;
};

/**
 * The node of the command for the expression that starts at `start`: the first one from there
 * on, and the widest of those that start together. Brackets around it belong to no node. With
 * an `end`, the widest that ends before it: the node of what is written between the two.
 */
const findExpressionRoot = (
  command: ESQLAstAllCommands | ESQLAstQueryExpression,
  start: number | undefined,
  end: number = Infinity
): ESQLSingleAstItem | undefined => {
  if (start === undefined) {
    return undefined;
  }

  const candidates = Walker.findAll(
    command,
    (node) =>
      node !== command &&
      node.location !== undefined &&
      node.location.min >= start &&
      node.location.max < end
  ) as ESQLSingleAstItem[];

  return candidates.reduce<ESQLSingleAstItem | undefined>((best, node) => {
    const { min, max } = node.location;
    const isBetter =
      !best || min < best.location.min || (min === best.location.min && max > best.location.max);

    return isBetter ? node : best;
  }, undefined);
};

const ARROW = '->';
const PARAMETER_NAMES: readonly string[] = ['x', 'y', 'z'];

/**
 * The parameters of lambdas as columns. A parameter has the type of the argument whose values
 * it stands for, when the function says which.
 */
const asColumns = (
  parameters: LambdaParameter[],
  command: ESQLAstAllCommands,
  columns: Map<string, ESQLColumnData>
): ESQLColumnData[] =>
  parameters.map(({ name, valuesFrom }) => ({
    name,
    type: getExpressionType(findExpressionRoot(command, valuesFrom), columns),
    userDefined: true,
    location: { min: 0, max: 0 },
  }));

/** The items of the head of a lambda: its parameters with the arrow, or the arrow alone. */
const provideLambdaHead = (
  lambda: Exclude<LambdaState, { kind: 'body' }>,
  { usedNames }: SuggestionContext
): ISuggestionItem[] => {
  if (lambda.kind === 'arrow') {
    return [withAutoSuggest({ label: ARROW, text: `${ARROW} `, kind: 'Operator', detail: '' })];
  }

  const free = PARAMETER_NAMES.filter((name) => !usedNames.has(name));
  const names = (free.length >= lambda.count ? free : PARAMETER_NAMES).slice(0, lambda.count);
  const head = names.length === 1 ? names[0] : `(${names.join(', ')})`;

  return [
    withAutoSuggest({
      label: `${head} ${ARROW}`,
      text: `${head} ${ARROW} `,
      kind: 'Variable',
      detail: '',
    }),
  ];
};

/**
 * The names another argument of the command defines, as columns: each with the type of the
 * value it stands for, read from the text the names were found in.
 */
const getDefinedColumns = (
  place: CallSiteId,
  { text, offset, ir }: SuggestionContext,
  columns: Map<string, ESQLColumnData>,
  unmappedFieldsStrategy: ICommandContext['unmappedFieldsStrategy']
): ESQLColumnData[] => {
  const defined = getDefinedNames(place, readToEndOfCommand(text, offset, ir));

  if (!defined) {
    return [];
  }

  const { root } = Parser.parse(defined.text);

  return defined.names.map(({ name, start, end }) => ({
    name,
    type: getExpressionType(findExpressionRoot(root, start, end), columns, unmappedFieldsStrategy),
    userDefined: true,
    location: { min: start, max: end - 1 },
  }));
};

/** The columns of the entity another argument names, as the index a join reads. */
const getEntityColumns = async (
  place: CallSiteId,
  { ir, callbacks }: SuggestionContext
): Promise<ESQLColumnData[]> => {
  const entity = ir.written.find(({ id }) => id === place);

  return entity ? (await callbacks?.getColumnsFor?.({ query: `FROM ${entity.text}` })) ?? [] : [];
};

/** A column the query and the named entity both have is marked as such, and listed first. */
const asShared = (item: ISuggestionItem): ISuggestionItem => ({
  ...item,
  detail: [
    item.detail,
    i18n.translate('esqlLanguage.esql.autocomplete.join.commonFieldNote', {
      defaultMessage: '(common field)',
    }),
  ]
    .filter(Boolean)
    .join(' '),
  category: SuggestionCategory.LOOKUP_COMMON_FIELD,
  documentation: {
    value: i18n.translate('esqlLanguage.esql.autocomplete.join.sharedField', {
      defaultMessage: 'Field shared between the source and the lookup index',
    }),
  },
});

const getCallbacks = (
  role: ExpressionRole,
  parameters: ESQLColumnData[],
  defined: ESQLColumnData[],
  shared: Set<string>,
  context: SuggestionContext
): ICommandCallbacks | undefined => {
  const { callbacks, hasLicense, getColumnsByType, usedNames } = context;
  const getColumnsFor = callbacks?.getColumnsFor;
  // A name the command defines stands in the place of the column of the same name.
  const redefined = new Set(defined.map(({ name }) => name));
  const getByType: ICommandCallbacks['getByType'] = async (type, ignored = [], options) => [
    ...buildFieldsDefinitionsWithMetadata(
      [
        ...parameters,
        ...defined.filter(
          ({ name, type: own }) => !ignored.includes(name) && !NOT_SUGGESTED_TYPES.includes(own)
        ),
      ].filter(({ type: own }) => type === 'any' || type.includes('any') || type.includes(own)),
      [],
      options
    ),
    ...(await getColumnsByType(type, ignored, options))
      .filter(({ label }) => !redefined.has(label))
      .map((item) => (shared.has(item.label) ? asShared(item) : item)),
  ];

  return {
    getByType: readsColumnsHere(role, context.ir) || parameters.length ? getByType : undefined,
    getSuggestedUserDefinedColumnName: () => {
      let index = 0;
      while (usedNames.has(`col${index}`)) {
        index++;
      }

      return `col${index}`;
    },
    getColumnsForQuery: getColumnsFor && (async (query: string) => getColumnsFor({ query })),
    hasMinimumLicenseRequired: hasLicense,
    getKqlSuggestions: callbacks?.getKqlSuggestions,
    canCreateLookupIndex: callbacks?.canCreateLookupIndex,
    canSuggestResourceBrowser: callbacks?.canSuggestResourceBrowser,
    isServerless: callbacks?.isServerless,
  };
};

/**
 * The expression at the cursor, by the role of the argument it is. The items come from the
 * expression engine the commands share today; this provider tells it what the role and the
 * grammar know: which functions apply, which types, and what is written of the expression.
 */
export const provideExpression = async (
  { role, resolved, entry }: Extract<SuggestionRequest, { kind: 'expression' }>,
  context: SuggestionContext
): Promise<ExpressionSuggestions> => {
  const { offset, ir, callbacks } = context;
  const lambda = getLambdaState(ir);

  if (lambda && lambda.kind !== 'body') {
    return { entry, items: provideLambdaHead(lambda, context), isUnfinished: true };
  }

  // The body of a lambda is the value of the argument: the expression engine reads it as
  // that once the parameters and the arrow before it are blanked out.
  const lambdas = getLambdas(ir);
  const text = lambdas.reduce(
    (blanked, { head: { start, end } }) =>
      `${blanked.slice(0, start)}${' '.repeat(end - start)}${blanked.slice(end)}`,
    context.text
  );
  const { root, astContext } = getAutocompleteCursorContext(text, offset);

  if (astContext.type !== 'expression') {
    return { entry, items: [], isUnfinished: false };
  }

  const { command, isCursorInSubquery } = astContext;
  const expressionRoot = findExpressionRoot(command, getWrittenStart(ir, entry));
  const canBrowseFields = (await callbacks?.canSuggestResourceBrowser?.()) ?? false;
  const columns = await context.getColumnMap();
  // Every parameter has a type for what is written with it; only the lambdas around the cursor
  // offer theirs.
  const typed = asColumns(
    lambdas.flatMap((written) => written.parameters),
    command,
    columns
  );
  const inScope = lambda?.kind === 'body' ? lambda.parameters.map(({ name }) => name) : [];
  const parameters = typed.filter(({ name }) => inScope.includes(name));
  const unmappedFieldsStrategy = getUnmappedFieldsStrategy(root.header);
  const entityColumns = role.columnsOf ? await getEntityColumns(role.columnsOf, context) : [];
  // What the role reads beyond the columns of the query: the names another argument defines,
  // and the columns of the entity another argument names.
  const defined = [
    ...(role.namesOf
      ? getDefinedColumns(role.namesOf, context, columns, unmappedFieldsStrategy)
      : []),
    ...entityColumns.filter(({ name }) => !columns.has(name)),
  ];
  const shared = new Set(
    entityColumns.filter(({ name }) => columns.has(name)).map(({ name }) => name)
  );
  const commandContext: ICommandContext = {
    columns: new Map([
      ...columns,
      ...[...typed, ...defined].map((column): [string, ESQLColumnData] => [column.name, column]),
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
  const request: SuggestForExpressionParams = {
    query: text,
    expressionRoot,
    command,
    cursorPosition: offset,
    location: locationOf(role, resolved, context),
    context: fullContext,
    callbacks: getCallbacks(role, parameters, defined, shared, context),
    options: {
      ...(role.types && { preferredExpressionType: [...role.types] }),
      ...(role.subqueries && { allowSubquery: true }),
      ...(role.unique && { ignoredColumnsForEmptyExpression: getListedColumns(ir, entry) }),
      ...(!readsColumnsHere(role, ir) && { suggestFields: false }),
      getFunctionsToIgnore: getFunctionsToIgnore(role, ir, entry),
    },
  };
  const expressionType = getExpressionType(
    expressionRoot,
    fullContext.columns,
    fullContext.unmappedFieldsStrategy,
    fullContext.isTimeseriesSource === true
  );
  const typeOf = ({ start, end }: { start: number; end: number }) =>
    getExpressionType(
      findExpressionRoot(command, start, end),
      fullContext.columns,
      fullContext.unmappedFieldsStrategy,
      fullContext.isTimeseriesSource === true
    );
  // The grammar says which call the cursor is in; the node of that call gives the types of
  // the arguments written in it.
  const getParameter = (
    { start, name }: { start: number; name?: string },
    startsArgument: boolean
  ) => {
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
  };
  // The position comes from the grammar, and so does every decision about what to offer.
  const position = describeExpressionPosition(ir, entry);
  const items = await decideExpression({
    ir,
    position,
    request,
    expressionType,
    typeOf,
    getParameter,
  });
  const isComplete = isExpressionComplete(expressionType, text.slice(0, offset));
  const hasItsType = !role.completeAs || expressionType === role.completeAs;
  // Where the items are computed values that can be given a name, a column alone is not a
  // finished item: it computes nothing, and it may still be the name.
  const mayStillBeName =
    role.computes === true &&
    ir.followers.some(isAssignmentToken) &&
    isLoneColumn(getCurrentItem(ir, entry));
  // Where a grouping starts, the editor also offers a ready-made date histogram.
  const startsGrouping = role.mode === 'grouping' && position.kind === 'empty' && !position.call;
  const histogram = startsGrouping
    ? [
        (context.sourceIsTimeSeries
          ? getTimeseriesDateHistogramCompletionItem
          : getDateHistogramCompletionItem)(
          (await callbacks?.getPreferences?.())?.histogramBarTarget
        ),
      ]
    : [];

  // Where the expression starts and nothing is typed yet, the editor also offers the
  // ready-made values it has for it.
  const starter = resolved.id === undefined ? undefined : getStartingValues()[resolved.id];
  const readyMade =
    position.kind === 'empty' && !position.call && !ir.word
      ? [...getValueSnippet(role.format), ...(starter ? [starter] : [])]
      : [];

  return {
    entry,
    items: [...items, ...histogram, ...readyMade],
    isUnfinished: (expressionRoot !== undefined && !(isComplete && hasItsType)) || mayStillBeName,
  };
};
