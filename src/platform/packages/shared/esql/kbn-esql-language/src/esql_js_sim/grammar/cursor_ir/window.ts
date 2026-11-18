/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Parser } from '@elastic/esql';
import { Token } from 'antlr4';
import { classifyToken } from './token_classes';

/*
 * Reading a long query costs by its length, and most of the length is commands the cursor is
 * not in. The commands between the first one of the pipeline and the one at the cursor are
 * blanked out: the text keeps its length, so every offset stays, and whatever reads it reads
 * two commands. What was blanked does not change while the command at the cursor is typed,
 * so it is found once and reused.
 */

/** A text with the commands the cursor is not in blanked out. */
export interface CommandWindow {
  /** The text, of the same length: every offset is the one of the text it was made from. */
  text: string;
  /** The text of the commands before the one at the cursor, when some were blanked. */
  earlier?: string;
  /** Where the command at the cursor starts in the pipeline: after the pipe at this offset. */
  lastPipe?: number;
}

interface Pipes {
  first: number;
  last: number;
}

/** The first and the last pipe of a text that are in no bracket. */
const findPipes = (text: string): Pipes | undefined => {
  const { tokens } = Parser.create(text);
  tokens.fill();
  let depth = 0;
  let first: number | undefined;
  let last: number | undefined;

  for (const { type, channel, start } of tokens.tokens) {
    if (channel !== Token.DEFAULT_CHANNEL) {
      continue;
    }

    const tokenClass = classifyToken(type, false);
    if (tokenClass === 'opener') {
      depth++;
    } else if (tokenClass === 'closer') {
      depth = Math.max(0, depth - 1);
    } else if (tokenClass === 'pipe' && depth === 0) {
      first ??= start;
      last = start;
    }
  }

  return first === undefined || last === undefined ? undefined : { first, last };
};

const PIPE = '|';

const blank = (text: string, { first, last }: Pipes): string =>
  `${text.slice(0, first)}${' '.repeat(last - first)}${text.slice(last)}`;

// The pipes of the last text, with the text before the last one: the same from one key to
// the next while one command is typed.
let known: (Pipes & { earlier: string }) | undefined;

// The answer for the last text: one call of the editor asks for the same text several times.
let last: { textBefore: string; window: CommandWindow } | undefined;

/** Whether a text has at least two pipe characters: with fewer there is nothing to blank. */
const hasSeveralPipes = (text: string): boolean => {
  const first = text.indexOf(PIPE);

  return first >= 0 && text.indexOf(PIPE, first + 1) >= 0;
};

/**
 * The window on a text that ends at the cursor. While the text still starts with the commands
 * found last time, only the first command and what comes after them is read to find where
 * the command at the cursor starts.
 */
export const getCommandWindow = (textBefore: string): CommandWindow => {
  if (last?.textBefore !== textBefore) {
    last = {
      textBefore,
      window: hasSeveralPipes(textBefore) ? findWindow(textBefore) : { text: textBefore },
    };
  }

  return last.window;
};

const findWindow = (textBefore: string): CommandWindow => {
  const isSameStart =
    known !== undefined && textBefore[known.last] === PIPE && textBefore.startsWith(known.earlier);
  // With the earlier commands blanked, the pipe they ended at is the first one left.
  const pipes =
    known && isSameStart
      ? { first: known.first, last: findPipes(blank(textBefore, known))?.last ?? known.last }
      : findPipes(textBefore);

  if (!pipes) {
    known = undefined;

    return { text: textBefore };
  }

  known = { ...pipes, earlier: textBefore.slice(0, pipes.last) };

  return pipes.first === pipes.last
    ? { text: textBefore, lastPipe: pipes.last }
    : { text: blank(textBefore, pipes), earlier: known.earlier, lastPipe: pipes.last };
};
