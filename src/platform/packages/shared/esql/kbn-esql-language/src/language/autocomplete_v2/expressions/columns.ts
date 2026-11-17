/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { Parser } from '@elastic/esql';
import type { ESQLAstAllCommands } from '@elastic/esql/types';
import { SuggestionCategory } from '../../autocomplete/utils/sorting/types';
import {
  buildFieldsDefinitionsWithMetadata,
  getExpressionType,
} from '../../../commands/definitions/utils';
import type {
  ESQLColumnData,
  ICommandCallbacks,
  ICommandContext,
  ISuggestionItem,
} from '../../../commands/registry/types';
import type { CallSiteId, ExpressionRole } from '../../../esql_js_sim/definitions';
import { readToEndOfCommand } from '../../../esql_js_sim/grammar';
import { NOT_SUGGESTED_TYPES } from '../../../query_columns_service';
import type { SuggestionContext } from '../types';
import { pickColumnName } from '../written';
import type { LambdaParameter } from './lambdas';
import { getDefinedNames } from './names';
import { findExpressionRoot } from './tree';

/*
 * The names an expression can read beyond the columns of the query: the parameters of the
 * lambdas around the cursor, the names another argument of the command defines, and the
 * columns of an entity another argument names.
 */

type ColumnMap = Map<string, ESQLColumnData>;

/**
 * The parameters of lambdas as columns. A parameter has the type of the argument whose values
 * it stands for, when the function says which.
 */
export const getLambdaColumns = (
  parameters: LambdaParameter[],
  command: ESQLAstAllCommands,
  columns: ColumnMap
): ESQLColumnData[] =>
  parameters.map(({ name, valuesFrom }) => ({
    name,
    type: getExpressionType(findExpressionRoot(command, valuesFrom), columns),
    userDefined: true,
    location: { min: 0, max: 0 },
  }));

/**
 * The names another argument of the command defines, as columns: each with the type of the
 * value it stands for, read from the text the names were found in.
 */
const getDefinedColumns = (
  place: CallSiteId,
  { text, offset, ir }: SuggestionContext,
  columns: ColumnMap,
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

/** What the role reads beyond the columns of the query. */
export interface RoleColumns {
  /** Names that are not columns of the query. */
  defined: ESQLColumnData[];
  /** The columns the query and the named entity both have. */
  shared: Set<string>;
}

export const getRoleColumns = async (
  role: ExpressionRole,
  context: SuggestionContext,
  columns: ColumnMap,
  unmappedFieldsStrategy: ICommandContext['unmappedFieldsStrategy']
): Promise<RoleColumns> => {
  const entityColumns = role.columnsOf ? await getEntityColumns(role.columnsOf, context) : [];

  return {
    defined: [
      ...(role.namesOf
        ? getDefinedColumns(role.namesOf, context, columns, unmappedFieldsStrategy)
        : []),
      ...entityColumns.filter(({ name }) => !columns.has(name)),
    ],
    shared: new Set(entityColumns.filter(({ name }) => columns.has(name)).map(({ name }) => name)),
  };
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

/**
 * What the item builders ask the editor through. Columns come by type: the parameters in
 * scope and the defined names first, then the columns of the query. Without `readsColumns`
 * only the parameters are a reason to list any.
 */
export const getBuilderCallbacks = (
  parameters: ESQLColumnData[],
  { defined, shared }: RoleColumns,
  readsColumns: boolean,
  context: SuggestionContext
): ICommandCallbacks => {
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
    getByType: readsColumns || parameters.length ? getByType : undefined,
    getSuggestedUserDefinedColumnName: () => pickColumnName(usedNames),
    getColumnsForQuery: getColumnsFor && (async (query: string) => getColumnsFor({ query })),
    hasMinimumLicenseRequired: hasLicense,
    getKqlSuggestions: callbacks?.getKqlSuggestions,
    canCreateLookupIndex: callbacks?.canCreateLookupIndex,
    canSuggestResourceBrowser: callbacks?.canSuggestResourceBrowser,
    isServerless: callbacks?.isServerless,
  };
};
