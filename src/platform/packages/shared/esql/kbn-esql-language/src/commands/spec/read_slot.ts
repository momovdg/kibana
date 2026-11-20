/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isAtCursor, type Outcome, type Reading } from './reading';
import type { SpecToken } from './tokens';
import type { SlotNode } from './types';

const SEPARATOR = ',';

const isSeparator = (token: SpecToken | undefined): boolean => token?.text === SEPARATOR;

const isKeyword = ({ text }: SpecToken, { keywords }: Reading): boolean =>
  keywords.has(text.toUpperCase());

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

/** One value, or for a list one value after each comma. */
export const readSlot = (slot: SlotNode, reading: Reading): Outcome => {
  const { tokens, expected, keyword: after } = reading;
  const listed: string[] = [];

  // An expression is read by the code that offers it: it has the rest of the command.
  if (slot.role === 'expression') {
    expected.push({ kind: 'slot', slot, listed, after });

    return 'cursor';
  }

  let hasMore = true;

  while (hasMore) {
    if (isAtCursor(reading)) {
      expected.push({ kind: 'slot', slot, listed });

      return 'cursor';
    }
    if (isSeparator(tokens[reading.index]) || isKeyword(tokens[reading.index], reading)) {
      return 'invalid';
    }

    const end = endOfValue(tokens, reading.index);

    listed.push(
      tokens
        .slice(reading.index, end)
        .map(({ text }) => text)
        .join('')
    );
    hasMore = isList(slot) && isSeparator(tokens[end]);
    reading.index = hasMore ? end + 1 : end;
  }

  // A list can go on after any of its items.
  if (isList(slot) && isAtCursor(reading)) {
    expected.push({ kind: 'separator' });
  }

  return 'written';
};
