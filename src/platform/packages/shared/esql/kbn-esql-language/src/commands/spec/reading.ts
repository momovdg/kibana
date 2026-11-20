/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { SpecToken } from './tokens';
import type { Keyword, SlotNode } from './types';

/** What the spec allows at the cursor. */
export type Expected =
  /**
   * A slot, with what is already written of it where it is a list, and the keyword it comes
   * after where there is one.
   */
  | { kind: 'slot'; slot: SlotNode; listed: string[]; after?: Keyword }
  | { kind: 'keyword'; text: Keyword }
  /** The comma before the next item of a list. */
  | { kind: 'separator' }
  | { kind: 'end' };

/** The reading of the tokens so far: how many are read, and what can come at the cursor. */
export interface Reading {
  tokens: SpecToken[];
  index: number;
  expected: Expected[];
  /** The keywords of the spec: one of them is never the value of a slot. */
  keywords: ReadonlySet<string>;
  /** The last keyword read. */
  keyword?: Keyword;
}

/**
 * How reading a part of the spec ended: it is all written, or the cursor is in it and nothing
 * after it can come yet, or the text does not follow it.
 */
export type Outcome = 'written' | 'cursor' | 'invalid';

export const isAtCursor = ({ tokens, index }: Reading): boolean => index >= tokens.length;
