/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type {
  ESQLAstHighlightCommand,
  ESQLAstItem,
  ESQLColumn,
  ESQLFunction,
  ESQLIdentifier,
} from '@elastic/esql/types';
import {
  Walker,
  isColumn,
  isFunctionExpression,
  isIdentifier,
  isParamLiteral,
} from '@elastic/esql';
import type { ESQLColumnData } from '../types';
import { isTextColumn } from '../../definitions/utils/full_text_match';

/**
 * The keyword accepted by the optional `prefix = "..."` modifier. Elasticsearch rejects
 * any other identifier there.
 */
export const HIGHLIGHT_PREFIX_KEYWORD = 'prefix';

/**
 * Prefix applied to the generated columns when `prefix = "..."` is not specified.
 * Mirrors `Highlight.DEFAULT_PREFIX` in Elasticsearch.
 */
export const HIGHLIGHT_DEFAULT_PREFIX = 'highlight_';

/**
 * The identifier on the left of the `prefix = "..."` assignment, when the command has one.
 * The parser accepts any identifier there, so callers must check it against
 * {@link HIGHLIGHT_PREFIX_KEYWORD} — Elasticsearch rejects anything else.
 */
export const getPrefixKeyword = (
  command: ESQLAstHighlightCommand
): ESQLColumn | ESQLIdentifier | undefined => {
  const assignment = command.args.find(
    (arg): arg is ESQLFunction =>
      !Array.isArray(arg) && isFunctionExpression(arg) && arg.name === '='
  );

  if (!assignment) {
    return undefined;
  }

  const [left] = assignment.args;

  return !Array.isArray(left) && (isColumn(left) || isIdentifier(left)) ? left : undefined;
};

/** The prefix applied to the generated columns, falling back to the Elasticsearch default. */
export const getHighlightPrefix = (command: ESQLAstHighlightCommand): string =>
  command.prefix?.valueUnquoted ?? HIGHLIGHT_DEFAULT_PREFIX;

/** Functions whose first argument is the field the query targets. */
const FIELD_TARGETING_QUERY_FUNCTIONS = ['match', 'match_phrase', ':'];

const WILDCARD = '*';

/**
 * The field a field-targeting function searches, or undefined when it is not a plain column,
 * such as an unresolved parameter (`?field`, or `??field` that parses as a column).
 */
const getTargetFieldName = ({ args: [target] }: ESQLFunction): string | undefined =>
  !Array.isArray(target) && isColumn(target) && !target.args.some(isParamLiteral)
    ? target.name
    : undefined;

/** Names of the fields a field-targeting query (MATCH, MATCH_PHRASE, `:`) searches. */
export const getQueryFieldNames = (queryExpression: ESQLAstItem): string[] => {
  const queryFields: string[] = [];

  Walker.walk(queryExpression as ESQLFunction, {
    visitFunction: (fn) => {
      if (!FIELD_TARGETING_QUERY_FUNCTIONS.includes(fn.name.toLowerCase())) {
        return;
      }

      const fieldName = getTargetFieldName(fn);

      if (fieldName !== undefined) {
        queryFields.push(fieldName);
      }
    },
  });

  return queryFields;
};

/** Collects the fields a query narrows to; false when it cannot be narrowed. */
const collectDerivedFieldNames = (expression: ESQLAstItem, names: string[]): boolean => {
  if (Array.isArray(expression) || !isFunctionExpression(expression)) {
    return false;
  }

  const name = expression.name.toLowerCase();

  if (FIELD_TARGETING_QUERY_FUNCTIONS.includes(name)) {
    const fieldName = getTargetFieldName(expression);

    // A field that cannot be resolved here, such as a parameter, could be any column.
    if (fieldName === undefined) {
      return false;
    }

    names.push(fieldName);

    return true;
  }

  if (name === 'and' || name === 'or') {
    return expression.args.every((arg) => collectDerivedFieldNames(arg, names));
  }

  // A negated condition highlights nothing, but it does not widen the fields either, unless it
  // holds a QSTR, which names no field.
  if (name === 'not') {
    const [operand] = expression.args;
    let hasQueryString = false;

    Walker.walk(operand as ESQLFunction, {
      visitFunction: (fn) => {
        hasQueryString ||= fn.name.toLowerCase() === 'qstr';
      },
    });

    return !hasQueryString && collectDerivedFieldNames(operand, []);
  }

  return false;
};

/**
 * The fields an omitted ON resolves to: the ones the query names, or undefined when the query
 * cannot be narrowed to fields (a string literal, QSTR, KQL, or any of them combined with
 * field-targeting conditions), which highlights every text column instead.
 */
export const deriveQueryFieldNames = (queryExpression: ESQLAstItem): string[] | undefined => {
  const names: string[] = [];

  return collectDerivedFieldNames(queryExpression, names) ? names : undefined;
};

/** Every text and keyword column, which is what `ON *` covers; metadata columns are excluded. */
const getHighlightableColumnNames = (columns: ESQLColumnData[]): string[] =>
  columns.filter(isTextColumn).map(({ name }) => name);

/**
 * The columns an earlier WHERE targets with its positive full-text conditions: the ones it
 * marked, or every text column when a condition names no field. With nothing marked there is no
 * query to reuse, which Elasticsearch rejects, so no column is generated.
 */
const getReusedWhereColumnNames = (columns: ESQLColumnData[]): string[] => {
  const markedColumns = columns.filter(({ fullTextMatch }) => fullTextMatch !== undefined);

  return markedColumns.some(({ fullTextMatch }) => fullTextMatch === 'all')
    ? getHighlightableColumnNames(columns)
    : markedColumns.map(({ name }) => name);
};

/**
 * The fields HIGHLIGHT highlights. Without ON they come from the query: the fields a
 * field-targeting query searches, or every text and keyword column. With no query either, they
 * come from the earlier WHERE that the columns record.
 */
const getHighlightFieldNames = (
  command: ESQLAstHighlightCommand,
  columns: ESQLColumnData[]
): string[] => {
  const { highlightFields, queryExpression } = command;

  if (highlightFields === undefined) {
    if (queryExpression === undefined) {
      return getReusedWhereColumnNames(columns);
    }

    const queryFields = deriveQueryFieldNames(queryExpression);

    if (queryFields === undefined) {
      return getHighlightableColumnNames(columns);
    }

    // Like Elasticsearch, a named field that is not a text column of the input is left out.
    const textColumnNames = getHighlightableColumnNames(columns);

    return columns.length === 0
      ? queryFields
      : queryFields.filter((field) => textColumnNames.includes(field));
  }

  return highlightFields.flatMap((field) => {
    // A parameter cannot be resolved to a column name without its value.
    if (!isColumn(field) && !isIdentifier(field)) {
      return [];
    }

    if (field.name === WILDCARD) {
      return getHighlightableColumnNames(columns);
    }

    // Any other pattern is rejected by validation, so it has no column to generate.
    return field.name.includes(WILDCARD) ? [] : [field.name];
  });
};

/**
 * Names of the columns HIGHLIGHT generates: one per highlighted field, prefixed. An empty prefix
 * makes the highlighted value overwrite the source column. The `columns` are needed to resolve
 * `ON *`, and an omitted ON that is derived from the query.
 */
export const getHighlightColumnNames = (
  command: ESQLAstHighlightCommand,
  columns: ESQLColumnData[] = []
): string[] => {
  const prefix = getHighlightPrefix(command);

  return getHighlightFieldNames(command, columns).map((name) => `${prefix}${name}`);
};
