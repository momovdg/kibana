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
export type Expected = { kind: 'slot'; slot: SlotNode } | { kind: 'end' };

/** Where the cursor is in the spec of a command. */
export interface SpecPosition {
  /** What can come at the cursor, in the order of the spec. */
  expected: Expected[];
  /** The text does not follow the spec: nothing is offered. */
  isInvalid: boolean;
}

/** The index after a value: its first token and the tokens written right against it. */
const endOfValue = (tokens: SpecToken[], from: number): number => {
  let index = from + 1;

  while (index < tokens.length && tokens[index].start === tokens[index - 1].end) {
    index++;
  }

  return index;
};

/**
 * Finds where the end of the tokens is in the spec of a command: what can come next there.
 * The tokens are what is written of the command after its name, up to the cursor.
 */
export const matchSpec = (spec: CommandSpec, tokens: SpecToken[]): SpecPosition => {
  let index = 0;

  for (const node of spec) {
    // The tokens are used up: this node is what comes next.
    if (index >= tokens.length) {
      return { expected: [{ kind: 'slot', slot: node }], isInvalid: false };
    }

    index = endOfValue(tokens, index);
  }

  // Everything the spec has is written. Tokens that are left over do not belong to it.
  return index < tokens.length
    ? { expected: [], isInvalid: true }
    : { expected: [{ kind: 'end' }], isInvalid: false };
};
