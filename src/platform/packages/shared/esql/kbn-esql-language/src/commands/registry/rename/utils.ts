/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation } from '../../../language/shared/cursor_location/types';

export enum RenamePosition {
  /** Typing the `a` of `AS` after the first name of a clause. */
  TYPING_AS = 'typing_as',
  /** After the first name of a clause, where `AS` or `=` follows. */
  AFTER_FIRST_NAME = 'after_first_name',
  /** After `AS`, where the new name is typed freely. */
  AFTER_AS = 'after_as',
  /** After `=`, where an existing column follows. */
  AFTER_ASSIGN = 'after_assign',
  /** After a complete clause, where a comma or pipe follows. */
  AFTER_CLAUSE = 'after_clause',
  /** At the start of a clause, or while a name is being typed. */
  NAME = 'name',
}

/** Maps the grammar's view of the cursor to a RENAME position. */
export const getPosition = ({
  expectedTokens,
  partial,
  commandCanEnd,
  previousTokenType,
}: CursorLocation): RenamePosition => {
  const expectsAs = expectedTokens.has(getTokenType('AS'));

  if (partial) {
    return expectsAs && partial.text.toLowerCase() === 'a'
      ? RenamePosition.TYPING_AS
      : RenamePosition.NAME;
  }
  if (expectsAs) {
    return RenamePosition.AFTER_FIRST_NAME;
  }
  if (commandCanEnd && expectedTokens.has(getTokenType('COMMA'))) {
    return RenamePosition.AFTER_CLAUSE;
  }
  if (previousTokenType === getTokenType('AS')) {
    return RenamePosition.AFTER_AS;
  }
  if (previousTokenType === getTokenType('ASSIGN')) {
    return RenamePosition.AFTER_ASSIGN;
  }
  return RenamePosition.NAME;
};

/** The first name of the clause at the cursor, as typed (e.g. `` `my field` `` or `a.b`). */
export const getFirstName = ({ expectedRules }: CursorLocation): string =>
  expectedRules.find(({ rule, continuation }) => continuation && rule === 'qualifiedNamePattern')
    ?.text ?? '';
