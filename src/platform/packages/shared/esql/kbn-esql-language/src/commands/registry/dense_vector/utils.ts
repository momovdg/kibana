/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type {
  ESQLAstDenseVectorCommand,
  ESQLColumn,
  ESQLFunction,
  ESQLIdentifier,
} from '@elastic/esql/types';
import { isColumn, isFunctionExpression, isIdentifier } from '@elastic/esql';

/**
 * The keyword accepted by the `suffix = "..." ON ...` modifier. The grammar accepts any
 * identifier there, so callers must check it against this value — Elasticsearch rejects
 * anything else.
 */
export const DENSE_VECTOR_SUFFIX_KEYWORD = 'suffix';

/** Suffix applied to the generated columns when `suffix = "..."` is not specified. */
export const DENSE_VECTOR_DEFAULT_SUFFIX = '_dense_vector';

/**
 * The identifier on the left of the naming assignment (`suffix = "_dv"`, `vec = field`), when
 * the command has one.
 *
 * The parser accepts any identifier there and does not keep it on the command, so callers must
 * check it against {@link DENSE_VECTOR_SUFFIX_KEYWORD} themselves — Elasticsearch rejects
 * anything else in front of a suffix.
 */
export const getNamingKeyword = (
  command: ESQLAstDenseVectorCommand
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

/**
 * Names of the `dense_vector` columns the command generates. The source fields are kept, so
 * these are always additional — unlike the sibling TEXT command, which replaces them.
 *
 * One name per input field, suffixed. `target = <field>` instead names a single output column.
 */
export const getDenseVectorColumnNames = (command: ESQLAstDenseVectorCommand): string[] => {
  const { targetField, suffix, fields } = command;

  if (targetField !== undefined) {
    return [targetField.name];
  }

  const appliedSuffix = suffix?.valueUnquoted ?? DENSE_VECTOR_DEFAULT_SUFFIX;

  return (fields ?? []).filter(({ name }) => name).map(({ name }) => `${name}${appliedSuffix}`);
};
