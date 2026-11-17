/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { resolveRole } from '../../esql_js_sim/definitions';
import { provide } from './providers';
import { provideColumns } from './providers/arguments';
import { provideEntityNames } from './providers/entities';
import type { ExpressionSuggestions } from './providers/expressions';
import { isAssignmentToken, isUnknownName, opensSubquery } from './providers/tokens';
import type { ISuggestionItem } from '../../commands/registry/types';
import type { SuggestionContext, SuggestionRequest } from './types';
import { pathOf } from './written';

/*
 * The grammar says everything that can come at the cursor. What is written says more: a name
 * that does not exist can only be assigned, a list with nothing left needs no separator, an
 * unfinished expression has to be finished first. Each of those is one rule here, with a
 * name, and a request that a rule drops is not provided.
 */

/** What the rules read, worked out once per cursor. */
export interface PruneState {
  /** The request for the assignment after a name, when one can come. */
  assignment: SuggestionRequest | undefined;
  /** The items for it: none when the name is one that exists. */
  assigned: ISuggestionItem[];
  /** The expressions at the cursor that are written in part and not whole yet. */
  unfinished: string[];
  /** The name before the cursor was looked up and is not there. */
  isUnknownName: boolean;
  /** Every item of the list the cursor is after is listed. */
  isListExhausted: boolean;
  /** An entity is expected: its role says whether a subquery can stand for it. */
  roleDecidesSubquery: boolean;
}

/**
 * Whether the last thing written is an item of a list whose items are listed once, and every
 * one is listed now: nothing is left to go on with, so the list's separator is not offered.
 */
const hasNothingLeftToList = async (context: SuggestionContext): Promise<boolean> => {
  const last = context.ir.written.at(-1);
  // An item is a rule argument, or a value the grammar takes as a token.
  const isItem =
    last !== undefined && !last.open && (last.kind === 'rule' || last.class === 'value');
  const resolved = last && isItem ? resolveRole(pathOf(last)) : undefined;
  const role = resolved?.role;

  if (!resolved || !last || !(role?.kind === 'entity' || role?.kind === 'column') || !role.unique) {
    return false;
  }

  const count = async (unique: boolean): Promise<number> =>
    (role.kind === 'entity'
      ? await provideEntityNames({ ...role, unique }, resolved, context)
      : await provideColumns({ ...role, unique }, resolved, context)
    ).length;

  // Where nothing is known to list, as without an editor to ask, nothing is known to be left out.
  return (await count(true)) === 0 && (await count(false)) > 0;
};

/** Whether the request is for something of the command itself, outside these expressions. */
const isOutside = (request: SuggestionRequest, entries: string[]): boolean => {
  // What is written can still be the name of an assignment and not an expression at all.
  if (request.kind === 'token' && isAssignmentToken(request.follower)) {
    return false;
  }
  // The same holds for the word being typed: it can be the start of a new name.
  if (request.kind === 'argument' && request.resolved?.role.kind === 'new_name') {
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

/** Reads what the rules need from the requests and from what is written. */
export const getPruneState = async (
  requests: SuggestionRequest[],
  expressions: ExpressionSuggestions[],
  context: SuggestionContext
): Promise<PruneState> => {
  const assignment = requests.find(
    (request) => request.kind === 'token' && isAssignmentToken(request.follower)
  );

  return {
    assignment,
    assigned: assignment ? await provide(assignment, context) : [],
    unfinished: expressions.filter(({ isUnfinished }) => isUnfinished).map(({ entry }) => entry),
    isUnknownName: assignment !== undefined && (await isUnknownName(context)),
    isListExhausted: await hasNothingLeftToList(context),
    roleDecidesSubquery: requests.some(
      (request) => request.kind === 'argument' && request.resolved?.role.kind === 'entity'
    ),
  };
};

type PruneRule = (request: SuggestionRequest, state: PruneState) => boolean;

/** The rules, in the order they apply. Each says when a request is dropped. */
const PRUNE_RULES: Readonly<Record<string, PruneRule>> = {
  // The assignment is provided apart: its items say whether the name is a new one.
  assignmentIsProvidedApart: (request, { assignment }) => request === assignment,
  // A name that is being assigned is a new name: what would read it as an existing one at
  // the same place, as `AS` in a rename, does not apply.
  newNameIsNotReadAsExisting: (request, { assignment, assigned }) =>
    assigned.length > 0 &&
    request.kind === 'token' &&
    assignment?.kind === 'token' &&
    request.follower.path.join() === assignment.follower.path.join(),
  // Once every item of a list is listed, the list cannot go on.
  exhaustedListHasNoSeparator: (request, { isListExhausted }) =>
    isListExhausted && request.kind === 'token' && request.follower.class === 'separator',
  // A name that is known not to exist can only be new: nothing that follows an existing
  // one applies.
  nothingFollowsUnknownName: (request, state) =>
    state.isUnknownName && (request.kind === 'token' || request.kind === 'end_of_command'),
  // Where an entity is expected, its role says whether a subquery can stand for it: the
  // bracket alone does not.
  roleDecidesSubquery: (request, { roleDecidesSubquery }) =>
    roleDecidesSubquery && request.kind === 'token' && opensSubquery(request.follower),
  // While an expression is unfinished the command cannot go on: only the expression can.
  unfinishedExpressionComesFirst: (request, { unfinished }) =>
    unfinished.length > 0 && isOutside(request, unfinished),
};

/** The requests that are provided: the ones no rule drops. */
export const prune = (requests: SuggestionRequest[], state: PruneState): SuggestionRequest[] =>
  requests.filter((request) => !Object.values(PRUNE_RULES).some((rule) => rule(request, state)));
