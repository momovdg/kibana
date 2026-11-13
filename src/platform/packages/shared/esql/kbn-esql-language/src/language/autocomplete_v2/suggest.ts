/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLCallbacks } from '@kbn/esql-types';
import type { ISuggestionItem } from '../../commands/registry/types';
import {
  EXPRESSION_PARTS,
  type ArgumentRole,
  type ResolvedRole,
  type RoleKind,
} from '../../esql_js_sim/definitions';
import { locate, type CursorIR, type ExpectedArgument } from '../../esql_js_sim/grammar';
import { createContext } from './context';
import { provideColumns, provideConstant, provideNewName } from './providers/arguments';
import { provideCommandNames } from './providers/command_names';
import { provideEntities } from './providers/entities';
import { provideExpression, type ExpressionSuggestions } from './providers/expressions';
import {
  dependentName,
  dependentRoles,
  provideMap,
  provideOptionNames,
} from './providers/structured';
import { SUGGESTED_VALUES_BY_NAME } from './presentation';
import { withAutoSuggest } from '../../commands/definitions/utils/autocomplete/helpers';
import { SuggestionCategory } from '../autocomplete/utils/sorting/types';
import {
  isAssignment,
  provideAssignment,
  provideEndOfCommand,
  provideToken,
} from './providers/tokens';
import { resolve } from './resolve';
import type { SuggestionContext, SuggestionRequest } from './types';

const NOTHING_APPLIES: readonly string[] = ['inside_comment', 'invalid'];

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
      return provideNewName(role, context);
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
      const isInMap = EXPRESSION_PARTS[argument.id] !== undefined;
      const candidates = dependentRoles(role, context);
      const roles = candidates.filter((candidate) => (candidate.kind === 'map') === isInMap);
      const items = await Promise.all(
        roles.map((candidate) => provideForRole(candidate, argument, resolved, context))
      );

      return [
        ...items.flat(),
        ...(isInMap ? [] : provideSuggestedValues(role, resolved, context)),
        // A value that can be a map is offered its braces, the cursor inside.
        ...(!isInMap && candidates.some(({ kind }) => kind === 'map') ? [MAP_ITEM] : []),
      ];
    }
    // The providers of the other roles come with the next steps.
    default:
      return [];
  }
};

const MAP_ITEM: ISuggestionItem = withAutoSuggest({
  label: '{ }',
  text: '{ $0 }',
  asSnippet: true,
  kind: 'Value',
  category: SuggestionCategory.CONSTANT_VALUE,
});

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
    (id !== undefined && name !== undefined && SUGGESTED_VALUES_BY_NAME[id]?.[name]) || [];
  const isInString = context.ir.position === 'inside_string';

  return values.map((value) => ({
    label: value,
    text: isInString ? value : `"${value}"`,
    kind: 'Value',
    category: SuggestionCategory.CONSTANT_VALUE,
  }));
};

// The roles whose value can be a string, and so can be offered inside an open one.
const STRING_VALUED: readonly RoleKind[] = ['map', 'constant', 'dependent_value'];

/**
 * The terminator that has to follow a value here, as `;` after the value of a header
 * statement, unless it is already written after the cursor.
 */
const getClosingTerminator = ({ afterName, ir }: SuggestionContext): string | undefined => {
  const [only] = afterName.followers;
  const closes =
    afterName.followers.length === 1 &&
    // A value that could still go on, as a number, does not change what has to follow it.
    afterName.arguments.every(({ continues }) => continues) &&
    only.class === 'terminator';

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

const provide = async (
  request: SuggestionRequest,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  switch (request.kind) {
    case 'command_names':
      return provideCommandNames(request.commandRules, context);
    case 'token':
      // A terminator that is already written right after the cursor is not offered again.
      if (request.follower.class === 'terminator' && context.ir.next?.class === 'terminator') {
        return [];
      }

      return isAssignment(request.follower)
        ? provideAssignment(context)
        : provideToken(request.follower);
    case 'end_of_command':
      return provideEndOfCommand();
    case 'argument':
      return provideArgument(request, context);
    // Expressions are provided first: they decide whether the command can go on.
    case 'expression':
      return [];
  }
};

/** Whether the request is for something of the command itself, outside these expressions. */
const isOutside = (request: SuggestionRequest, entries: string[]): boolean => {
  // What is written can still be the name of an assignment and not an expression at all.
  if (request.kind === 'token' && isAssignment(request.follower)) {
    return false;
  }

  const path =
    request.kind === 'token'
      ? request.follower.path
      : request.kind === 'argument'
      ? request.argument.path
      : [];

  return !path.some((id) => entries.includes(id));
};

/** Keeps the first of the items that insert the same text. */
const present = (items: ISuggestionItem[]): ISuggestionItem[] => {
  const seen = new Set<string>();

  return items.filter(({ text, label }) => {
    const key = `${label}|${text}`;
    const isNew = !seen.has(key);
    seen.add(key);

    return isNew;
  });
};

/** What is offered at a cursor, with the items that continue the command kept apart. */
interface Collected {
  ir: CursorIR;
  context: SuggestionContext | undefined;
  /** Everything offered, before it is presented. */
  items: ISuggestionItem[];
  /** The items for what can follow in the command: its keywords, separators and its end. */
  continuations: Array<{ request: SuggestionRequest; items: ISuggestionItem[] }>;
}

const collect = async (
  fullText: string,
  offset: number,
  callbacks?: ESQLCallbacks
): Promise<Collected> => {
  const ir = locate(fullText, offset);

  if (NOTHING_APPLIES.includes(ir.position)) {
    return { ir, context: undefined, items: [], continuations: [] };
  }

  // Inside a string only a value can be offered: no keyword and no command starts there.
  // An expression has strings of its own, as the query of a search function.
  const requests = resolve(ir).filter(
    ({ kind }) => ir.position !== 'inside_string' || kind === 'argument' || kind === 'expression'
  );
  const context = await createContext(fullText, offset, ir, callbacks);

  const expressions: ExpressionSuggestions[] = await Promise.all(
    requests.flatMap((request) =>
      request.kind === 'expression' ? [provideExpression(request, context)] : []
    )
  );
  // While an expression is unfinished the command cannot go on: only the expression can.
  const unfinished = expressions
    .filter(({ isUnfinished }) => isUnfinished)
    .map(({ entry }) => entry);
  // A name that is not an existing column is a new name: only its assignment can follow, and
  // not what would read it as a column, as `AS` in a rename.
  const assignment = requests.find(
    (request) => request.kind === 'token' && isAssignment(request.follower)
  );
  const assigned = assignment ? await provide(assignment, context) : [];
  const isNewName = (request: SuggestionRequest): boolean =>
    assigned.length > 0 &&
    request.kind === 'token' &&
    assignment?.kind === 'token' &&
    request !== assignment &&
    request.follower.path.join() === assignment.follower.path.join();
  const provided = await Promise.all(
    requests
      .filter((request) => request !== assignment && !isNewName(request))
      .filter((request) => !unfinished.length || !isOutside(request, unfinished))
      .map(async (request) => ({ request, items: await provide(request, context) }))
  );

  return {
    ir,
    context,
    items: [
      ...expressions.flatMap((expression) => expression.items),
      ...assigned,
      ...provided.flatMap(({ items }) => items),
    ],
    continuations: provided.filter(
      ({ request }) => request.kind === 'token' || request.kind === 'end_of_command'
    ),
  };
};

const SEPARATOR_GAP = ' ';

/**
 * What can follow the word being typed when the word is already whole: the items the flow
 * offers one space later, each as the word with what follows it, so that one choice does
 * both. A column that exists and a keyword typed in full get every continuation of the
 * command; a complete value only the end of its statement.
 */
const provideFollowUps = async (
  fullText: string,
  offset: number,
  { ir, context }: Collected,
  callbacks?: ESQLCallbacks
): Promise<ISuggestionItem[] | undefined> => {
  const { word } = ir;

  if (!word?.complete || !context) {
    return undefined;
  }

  // A keyword typed in full is whole as a column that exists is.
  const isKeyword = word.keyword !== undefined;
  const isColumn =
    word.kind === 'name' && (await context.getColumnMap()).has(word.argument?.text ?? word.text);
  const isValue = !isKeyword && (word.kind === 'number' || word.kind === 'string');

  if (!isKeyword && !isColumn && !isValue) {
    return undefined;
  }

  const spaced = `${fullText.slice(0, offset)}${SEPARATOR_GAP}${fullText.slice(offset)}`;
  const { continuations } = await collect(spaced, offset + SEPARATOR_GAP.length, callbacks);
  const name = word.argument?.text ?? word.text;

  if (isValue) {
    return continuations
      .filter(({ request }) => request.kind === 'token' && request.follower.class === 'terminator')
      .flatMap(({ items }) => items);
  }

  return continuations.flatMap(({ request, items }) =>
    items.map((item) => {
      // The next line is offered as it is; a separator follows the name with no gap.
      if (request.kind === 'end_of_command') {
        return item;
      }

      const isSeparator = request.kind === 'token' && request.follower.class === 'separator';

      return { ...item, text: `${name}${isSeparator ? '' : SEPARATOR_GAP}${item.text}` };
    })
  );
};

/**
 * The grammar-driven autocomplete. Four steps: locate the cursor in the grammar, resolve what
 * has to be offered there, provide the items for each request, and present them.
 */
export const suggest = async (
  fullText: string,
  offset: number,
  callbacks?: ESQLCallbacks
): Promise<ISuggestionItem[]> => {
  const collected = await collect(fullText, offset, callbacks);
  const followUps = await provideFollowUps(fullText, offset, collected, callbacks);

  // A word that is already whole is offered with what follows it, and not as itself again.
  return present(followUps?.length ? followUps : collected.items);
};
