/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { COMMAND_FACTS, getExpressionEntry, resolveRole } from '../../esql_js_sim/definitions';
import type { CursorIR, ExpectedArgument, Follower } from '../../esql_js_sim/grammar';
import type { SuggestionRequest } from './types';

/** A place inside an expression: its tokens are offered with it, as its operators and brackets. */
export const isOfExpression = (path: string[]): boolean =>
  getExpressionEntry(path) !== undefined && resolveRole(path)?.role.kind === 'expression';

/**
 * Turns what the grammar says about the cursor into what has to be offered there. It is pure:
 * nothing is fetched, and the same cursor always gives the same requests.
 */
export const resolve = (ir: CursorIR): SuggestionRequest[] => {
  const requests: SuggestionRequest[] = [];
  const commandRules = [
    ...new Set(
      ir.followers.flatMap(({ startsCommand, command }) =>
        startsCommand && command ? [command] : []
      )
    ),
  ];

  if (commandRules.length) {
    requests.push({ kind: 'command_names', commandRules });
  }

  // The command can end here when the query can, or when the next command can start: the
  // editor then offers a new line, also inside a branch, which ends with a bracket.
  // Where the grammar lets a command end and it still needs an argument, the command cannot
  // end yet: right after its name, or before an argument Elasticsearch requires.
  const facts = ir.command === undefined ? undefined : COMMAND_FACTS[ir.command];
  const isWritten = (place: string): boolean =>
    ir.written.some(({ id, ancestors }) => id === place || ancestors.some((a) => a.id === place));
  // The places that are still required: of the places that meet a requirement, none is written.
  const missing = (facts?.requires ?? [])
    .map((places) => [places].flat())
    .filter((places) => !places.some(isWritten))
    .flat();
  const lacksArgument =
    (facts?.requiresArgument === true && ir.written.length <= 1) || missing.length > 0;
  // Before a required argument, a keyword is offered only when it leads to that argument or
  // goes on with what is being written: not one that comes after the argument.
  const current = ir.written.at(-1)?.ancestors[0]?.id;
  const comesLater = ({ class: tokenClass, path: [place] }: Follower): boolean =>
    missing.length > 0 &&
    tokenClass === 'keyword' &&
    place !== undefined &&
    place !== current &&
    !missing.includes(place);
  const canEnd =
    !lacksArgument &&
    ir.followers.some(({ class: tokenClass }) => tokenClass === 'end' || tokenClass === 'pipe');

  if (canEnd) {
    requests.push({ kind: 'end_of_command' });
  }

  // A clause that may be used once is not offered again: its keyword is already written at
  // the place that repeats the clauses.
  const isUsedUp = ({ id, class: tokenClass, path: [place] }: Follower): boolean =>
    tokenClass === 'keyword' &&
    place !== undefined &&
    (facts?.singleUse ?? []).includes(place) &&
    ir.written.some(
      (written) => written.id === id && written.ancestors.some((ancestor) => ancestor.id === place)
    );
  const isUnsupported = (place: string | undefined): boolean =>
    place !== undefined && (facts?.unsupported ?? []).includes(place);

  for (const follower of ir.followers) {
    if (follower.startsCommand || follower.class === 'end' || isUnsupported(follower.id)) {
      continue;
    }
    if ((follower.class === 'pipe' && lacksArgument) || comesLater(follower)) {
      continue;
    }
    if (isUsedUp(follower)) {
      continue;
    }
    if (follower.text !== undefined && !isOfExpression(follower.path)) {
      requests.push({ kind: 'token', follower });
    }
  }

  // A token with no fixed text that a rule takes directly is an argument too, as a METADATA
  // field: it has a call site and a role like one the grammar gives a rule to.
  const valueTokens: ExpectedArgument[] = ir.followers.flatMap(
    ({ class: tokenClass, id, path, token, command }) =>
      tokenClass === 'value' && id
        ? [{ id, rule: token, path: [...path, id], command, continues: false }]
        : []
  );

  // An argument is offered once per role: several paths of the grammar lead to the same one.
  const seen = new Set<string>();
  const isNew = (key: string): boolean => !seen.has(key) && Boolean(seen.add(key));

  for (const argument of [...ir.arguments, ...valueTokens]) {
    if (argument.path.some(isUnsupported)) {
      continue;
    }

    const resolved = resolveRole(argument.path, argument.rule);
    const key = resolved?.id ?? `${argument.id}|${resolved?.role.kind}`;

    if (resolved?.role.kind !== 'expression' && isNew(key)) {
      requests.push({ kind: 'argument', argument, resolved });
    }
  }

  // An expression is offered as a whole: its operands where an argument is expected in it, and
  // its operators where a token of it can follow.
  for (const { path } of [...ir.arguments, ...ir.followers]) {
    const entry = getExpressionEntry(path);
    const resolved = entry === undefined ? undefined : resolveRole(path);

    if (entry && resolved?.role.kind === 'expression' && isNew(`expression|${entry}`)) {
      requests.push({ kind: 'expression', role: resolved.role, resolved, entry });
    }
  }

  return requests;
};
