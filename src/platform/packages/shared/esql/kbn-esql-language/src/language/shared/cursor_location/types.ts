/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/** The innermost command around the cursor, up to the cursor. */
export interface CommandSegment {
  /** Offset of the command's first token, or the cursor when no token was typed yet. */
  start: number;
  /** The cursor offset. */
  end: number;
  text: string;
}

/** A grammar rule (slot) the cursor can fill. */
export interface ExpectedRule {
  rule: string;
  /** The rules above the slot, outermost first. */
  stack: string[];
  /**
   * The slot started before the cursor, so the cursor would extend it rather than start a new
   * one, e.g. a time unit after `NOW() - 1 `.
   */
  continuation: boolean;
}

export interface CursorLocation {
  segment: CommandSegment;
  /** The rules shared by every candidate, outermost first, e.g. `['processingCommand', 'keepCommand']`. */
  ruleStack: string[];
  /** Token types valid at the cursor, including `PIPE` and `EOF` or `RP` when the command can end. */
  expectedTokens: Set<number>;
  expectedRules: ExpectedRule[];
  /** The command is complete at the cursor, so a pipe may follow. */
  commandCanEnd: boolean;
  /** The word being typed, if any. */
  partial?: { text: string; start: number };
  /** The cursor is inside a comment; no candidates are collected. */
  inComment: boolean;
}
