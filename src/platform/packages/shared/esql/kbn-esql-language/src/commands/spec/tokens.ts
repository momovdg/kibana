/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLAstAllCommands } from '@elastic/esql/types';
import { getEsqlLexerTokens, isVisibleToken } from '../../language/shared/lexer_scope';

/** A token of a command, as the matcher needs it. */
export interface SpecToken {
  text: string;
  start: number;
  end: number;
}

// Everything from the last space or comma to the cursor.
const TYPED = /[^\s,]+$/;

/**
 * What is written of a command after its name, up to the cursor, and apart from it what is
 * being typed at the cursor: that is not written yet.
 */
export const readBeforeCursor = (
  innerText: string,
  { name, location }: ESQLAstAllCommands
): { tokens: SpecToken[]; typed: string } => {
  // What touches the cursor is still being typed: the editor filters the suggestions by it.
  // It is read from the text, as the lexer gives no token for a character it does not know.
  const [typed = ''] = innerText.match(TYPED) ?? [];
  const typedFrom = innerText.length - typed.length;
  const tokens = getEsqlLexerTokens(innerText)
    .filter(isVisibleToken)
    .filter(({ start }) => start >= location.min)
    .slice(name.split(' ').length)
    .map(({ text, start, stop }) => ({ text, start, end: stop + 1 }))
    .filter(({ end }) => end <= typedFrom);

  return { tokens, typed };
};
