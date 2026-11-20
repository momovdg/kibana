/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { SpecToken } from './tokens';
import type { CommandSpec, SlotNode } from './types';

/** What the spec allows at the cursor. */
export type Expected =
  /** A slot, with what is already written of it where it is a list. */
  | { kind: 'slot'; slot: SlotNode; listed: string[] }
  /** The comma before the next item of a list. */
  | { kind: 'separator' }
  | { kind: 'end' };

/** Where the cursor is in the spec of a command. */
export interface SpecPosition {
  /** What can come at the cursor, in the order of the spec. */
  expected: Expected[];
  /** The text does not follow the spec: nothing is offered. */
  isInvalid: boolean;
}

const SEPARATOR = ',';
const INVALID: SpecPosition = { expected: [], isInvalid: true };

const isSeparator = (token: SpecToken | undefined): boolean => token?.text === SEPARATOR;

/** Whether a slot takes several values, separated by commas. */
const isList = (slot: SlotNode): boolean => 'list' in slot && slot.list === true;

/** The index after a value: its first token and the tokens written right against it. */
const endOfValue = (tokens: SpecToken[], from: number): number => {
  let index = from + 1;

  while (
    index < tokens.length &&
    tokens[index].start === tokens[index - 1].end &&
    !isSeparator(tokens[index])
  ) {
    index++;
  }

  return index;
};

/**
 * Finds where the end of the tokens is in the spec of a command: what can come next there.
 * The tokens are what is written of the command after its name, up to the cursor.
 */
export const matchSpec = (spec: CommandSpec, tokens: SpecToken[]): SpecPosition => {
  const expected: Expected[] = [];
  let index = 0;

  for (const slot of spec) {
    const listed: string[] = [];

    // One value, or for a list one value after each comma.
    let hasMore = true;

    while (hasMore) {
      // The tokens are used up: a value of this slot is what comes next.
      if (index >= tokens.length) {
        return { expected: [...expected, { kind: 'slot', slot, listed }], isInvalid: false };
      }
      if (isSeparator(tokens[index])) {
        return INVALID;
      }

      const end = endOfValue(tokens, index);

      listed.push(
        tokens
          .slice(index, end)
          .map(({ text }) => text)
          .join('')
      );
      hasMore = isList(slot) && isSeparator(tokens[end]);
      index = hasMore ? end + 1 : end;
    }

    // A list can go on after any of its items.
    if (isList(slot) && index >= tokens.length) {
      expected.push({ kind: 'separator' });
    }
  }

  // Everything the spec has is written. Tokens that are left over do not belong to it.
  return index < tokens.length
    ? INVALID
    : { expected: [...expected, { kind: 'end' }], isInvalid: false };
};
