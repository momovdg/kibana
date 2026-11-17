/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ISuggestionItem } from '../../../commands/registry/types';
import type { ArgumentRole, ResolvedRole, RoleKind } from '../../../esql_js_sim/definitions';
import type { ExpectedArgument } from '../../../esql_js_sim/grammar';
import { describeAfterName } from '../after_name';
import { getSuggestedValuesByName } from '../presentation';
import type { SuggestionContext, SuggestionRequest } from '../types';
import { partOf } from '../written';
import { provideColumns, provideConstant, provideNewName } from './arguments';
import { provideCommandNames } from './command_names';
import { provideEntities } from './entities';
import {
  dependentName,
  dependentRoles,
  provideMap,
  provideMapBraces,
  provideOptionNames,
} from './structured';
import { provideEndOfCommand, provideForToken } from './tokens';
import { SuggestionCategory } from '../../autocomplete/utils/sorting/types';

/*
 * One provider per kind of request. This file only says which provider serves what: a
 * provider knows the kind of thing it offers, never a command.
 */

/** The items for an argument that has a role, by the kind of the role alone. */
const provideForRole = async (
  role: ArgumentRole,
  argument: ExpectedArgument,
  resolved: ResolvedRole,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  switch (role.kind) {
    case 'column':
      return provideColumns(role, resolved, context);
    case 'new_name':
      return provideNewName(role, resolved, context);
    case 'constant':
      return provideConstant(role, resolved, context);
    case 'entity':
      return provideEntities(role, resolved, context);
    case 'option_name':
      return provideOptionNames(role, resolved, context);
    case 'map':
      return provideMap(role, argument, context);
    // The value takes the role its name gives it. A map is offered only inside a map, and
    // the other roles only outside one.
    case 'dependent_value': {
      const isInMap = partOf(argument) !== undefined;
      const candidates = dependentRoles(role, context);
      const roles = candidates.filter((candidate) => (candidate.kind === 'map') === isInMap);
      const owner = dependentName(role, context)?.toLowerCase();
      const items = await Promise.all(
        roles.map((candidate) =>
          candidate.kind === 'map'
            ? provideMap(candidate, argument, context, owner)
            : provideForRole(candidate, argument, resolved, context)
        )
      );

      return [
        ...items.flat(),
        ...(isInMap ? [] : provideSuggestedValues(role, resolved, context)),
        // A value that can be a map is offered its braces, the cursor inside.
        ...(!isInMap && candidates.some(({ kind }) => kind === 'map') ? provideMapBraces() : []),
      ];
    }
    // The providers of the other roles come with the next steps.
    default:
      return [];
  }
};

/**
 * The values the editor suggests for the value of a name, as the common values of a setting.
 * They are strings: quoted, unless the cursor is already inside the quotes.
 */
const provideSuggestedValues = (
  role: Extract<ArgumentRole, { kind: 'dependent_value' }>,
  { id }: ResolvedRole,
  context: SuggestionContext
): ISuggestionItem[] => {
  const name = dependentName(role, context)?.toLowerCase();
  const values =
    (id !== undefined && name !== undefined && getSuggestedValuesByName()[id]?.[name]) || [];
  const isInString = context.ir.position === 'inside_string';

  return values.map(
    (value): ISuggestionItem =>
      typeof value === 'string'
        ? {
            label: value,
            text: isInString ? value : `"${value}"`,
            kind: 'Value',
            category: SuggestionCategory.CONSTANT_VALUE,
          }
        : value
  );
};

// The roles whose value can be a string, and so can be offered inside an open one.
const STRING_VALUED: readonly RoleKind[] = ['map', 'constant', 'dependent_value'];

/**
 * The terminator that has to follow a value here, as `;` after the value of a header
 * statement, unless it is already written after the cursor.
 */
const getClosingTerminator = ({ afterName, ir }: SuggestionContext): string | undefined => {
  const { only, hasOnlyOpenArguments } = describeAfterName(afterName);
  // A value that could still go on, as a number, does not change what has to follow it.
  const closes = hasOnlyOpenArguments && only?.class === 'terminator';

  return closes && ir.next?.class !== 'terminator' ? only.text : undefined;
};

const provideArgument = async (
  { argument, resolved }: Extract<SuggestionRequest, { kind: 'argument' }>,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  // An argument that is already written is offered again only while the cursor is still in it.
  const isBeingTyped = context.ir.position === 'inside_argument' || context.ir.word?.argument;
  if (!resolved || (argument.continues && !isBeingTyped)) {
    return [];
  }
  if (context.ir.position === 'inside_string' && !STRING_VALUED.includes(resolved.role.kind)) {
    return [];
  }

  const items = await provideForRole(resolved.role, argument, resolved, context);
  const terminator = getClosingTerminator(context);

  // A value that ends its statement gets the terminator with it, so one choice finishes both.
  return terminator === undefined || context.ir.position === 'inside_string'
    ? items
    : items.map((item) => ({ ...item, text: `${item.text.trimEnd()}${terminator}` }));
};

/** The items for a request, by its kind. Expressions are provided apart, before the rest. */
export const provide = async (
  request: SuggestionRequest,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  switch (request.kind) {
    case 'command_names':
      return provideCommandNames(request.commandRules, context);
    case 'token':
      return provideForToken(request.follower, context);
    case 'end_of_command':
      return provideEndOfCommand();
    case 'argument':
      return provideArgument(request, context);
    // Expressions are provided first: they decide whether the command can go on.
    case 'expression':
      return [];
  }
};
