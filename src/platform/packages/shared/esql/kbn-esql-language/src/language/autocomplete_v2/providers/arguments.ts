/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { getNewUserDefinedColumnSuggestion } from '../../../commands/registry/complete_items';
import type { ISuggestionItem } from '../../../commands/registry/types';
import {
  type ColumnRole,
  type ConstantRole,
  type NewNameRole,
  type ResolvedRole,
} from '../../../esql_js_sim/definitions';
import { SuggestionCategory } from '../../autocomplete/utils/sorting/types';
import {
  buildUserDefinedColumnsDefinitions,
  withAutoSuggest,
} from '../../../commands/definitions/utils/autocomplete/helpers';
import {
  buildConstantsDefinitions,
  getDateLiterals,
} from '../../../commands/definitions/utils/literals';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import { getRegisteredCommand } from '../command_metadata';
import {
  getSuggestedValues,
  getValueSnippet,
  NAMED_AFTER_COMMAND,
  SUGGESTED_NAMES,
} from '../presentation';
import type { SuggestionContext } from '../types';
import { ASSIGNMENT, pickColumnName, writtenWithRole } from '../written';

/**
 * Whether the item for an argument ends with a space and opens the next suggestions. It does
 * unless the argument is an item of a list: there a separator can follow it, and the editor
 * offers the separator on the name itself, so that `a` becomes `a, ` and not `a , `.
 */
const movesOn = ({ afterName }: SuggestionContext): boolean =>
  afterName.position !== 'invalid' &&
  !afterName.followers.some((follower) => follower.class === 'separator');

/** The existing columns the role accepts. A column listed once is not offered again. */
export const provideColumns = async (
  role: ColumnRole,
  resolved: ResolvedRole,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  const moveOn = movesOn(context);
  const listed = writtenWithRole(context.ir.written, resolved.id);
  // A lone `*` stands for every column the role takes: offered while no column is listed.
  const everyColumn: ISuggestionItem[] =
    role.wildcard === 'alone' && listed.length === 0
      ? [
          withAutoSuggest({
            label: '*',
            text: '*',
            kind: 'Value',
            category: SuggestionCategory.RECOMMENDED_FIELD,
          }),
        ]
      : [];

  return [
    ...everyColumn,
    ...(await context.getColumnsByType(
      role.types ? [...role.types] : 'any',
      role.unique ? listed : [],
      { advanceCursor: moveOn, openSuggestions: true }
    )),
  ];
};

/** The name the editor suggests for a place: one of its own, or the name of the command. */
const getSuggestedName = (id: string | undefined, ir: CursorIR): string | undefined => {
  const name = id === undefined ? undefined : SUGGESTED_NAMES[id];

  return name === NAMED_AFTER_COMMAND ? ir.command && getRegisteredCommand(ir.command)?.name : name;
};

/**
 * The name the editor suggests for the place, when it has one. A separator that has to
 * follow the name, as the comma before a second name, comes with it.
 */
const provideSuggestedName = (
  { id }: ResolvedRole,
  { afterName, ir }: SuggestionContext
): ISuggestionItem[] => {
  const name = getSuggestedName(id, ir);
  const { followers } = afterName;
  const separator =
    followers.length > 0 && followers.every((follower) => follower.class === 'separator')
      ? `${followers[0].text} `
      : '';

  return name === undefined
    ? []
    : buildUserDefinedColumnsDefinitions([name]).map((item) =>
        withAutoSuggest({ ...item, text: `${item.text}${separator}` })
      );
};

/**
 * A name for a new column, where the grammar wants the name assigned: a name the query does
 * not use yet, followed by the assignment. Where any name can be typed freely, as after
 * RENAME's AS, nothing is offered.
 */
export const provideNewName = (
  role: NewNameRole,
  resolved: ResolvedRole,
  context: SuggestionContext
): ISuggestionItem[] => {
  const isAssigned = context.afterName.followers.some(({ text }) => text === ASSIGNMENT);

  if (role.of !== 'column') {
    return [];
  }
  if (!isAssigned) {
    return provideSuggestedName(resolved, context);
  }

  // The name the editor suggests for the place is selected once inserted, so typing renames it.
  const suggested = getSuggestedName(resolved.id, context.ir);
  if (suggested !== undefined) {
    return [
      withAutoSuggest({
        label: suggested,
        text: `\${1:${suggested}} ${ASSIGNMENT} `,
        asSnippet: true,
        kind: 'Variable',
        category: SuggestionCategory.USER_DEFINED_COLUMN,
      }),
    ];
  }

  return [getNewUserDefinedColumnSuggestion(pickColumnName(context.usedNames))];
};

/** The values a constant can take, when its role lists them. */
export const provideConstant = (
  role: ConstantRole,
  resolved: ResolvedRole,
  context: SuggestionContext
): ISuggestionItem[] => {
  const suffix = movesOn(context) ? ' ' : '';
  const suggested = resolved.id === undefined ? undefined : getSuggestedValues()[resolved.id];

  // Values the editor suggests where the language allows any: the cursor moves on after one.
  if (!role.allowedValues && suggested) {
    return buildConstantsDefinitions([...suggested.values], suggested.detail ?? '', {
      advanceCursorAndOpenSuggestions: true,
    });
  }

  // A date is a point in time: the ones the editor knows, as the start and the end of its
  // time range.
  if (role.valueType === 'date' && !role.allowedValues) {
    return getDateLiterals();
  }

  // A string with a known use gets a ready-made one, and one with a default gets the default,
  // selected so that typing replaces it. Not when the quotes are already open.
  const isInString = context.ir.position === 'inside_string';
  const defaultValue: ISuggestionItem[] =
    role.valueType === 'string' && role.default !== undefined && !role.allowedValues
      ? [
          {
            label: role.default,
            text: `"\${0:${role.default}}"`,
            asSnippet: true,
            kind: 'Constant',
            category: SuggestionCategory.CONSTANT_VALUE,
          },
        ]
      : [];
  const snippet = isInString ? [] : [...getValueSnippet(resolved.id), ...defaultValue];

  return [
    ...snippet,
    ...(role.allowedValues ?? []).map(
      (value): ISuggestionItem => ({
        label: value,
        text: `${value}${suffix}`,
        kind: 'Value',
        category: SuggestionCategory.VALUE,
      })
    ),
  ];
};
