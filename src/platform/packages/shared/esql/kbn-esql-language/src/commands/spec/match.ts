/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readSlot } from './read_slot';
import { isAtCursor, type Expected, type Outcome, type Reading } from './reading';
import type { SpecToken } from './tokens';
import type { CommandSpec, Keyword, KeywordNode, OptionalNode, SpecNode } from './types';

/** Where the cursor is in the spec of a command. */
export interface SpecPosition {
  /** What can come at the cursor, in the order of the spec. */
  expected: Expected[];
  /** The text does not follow the spec: nothing is offered. */
  isInvalid: boolean;
}

const INVALID: SpecPosition = { expected: [], isInvalid: true };

const readKeyword = ({ text }: KeywordNode, reading: Reading): Outcome => {
  if (isAtCursor(reading)) {
    reading.expected.push({ kind: 'keyword', text });

    return 'cursor';
  }
  if (reading.tokens[reading.index].text.toUpperCase() !== text) {
    return 'invalid';
  }

  reading.index++;
  reading.keyword = text;

  return 'written';
};

/** A part that may be left out is there when its keyword is written. */
const readOptional = ({ nodes }: OptionalNode, reading: Reading): Outcome => {
  const [{ text }] = nodes;

  // It can start at the cursor, and so can what comes after it.
  if (isAtCursor(reading)) {
    reading.expected.push({ kind: 'keyword', text });

    return 'written';
  }

  return reading.tokens[reading.index].text.toUpperCase() === text
    ? readNodes(nodes, reading)
    : 'written';
};

const readNode = (node: SpecNode, reading: Reading): Outcome => {
  switch (node.kind) {
    case 'slot':
      return readSlot(node, reading);
    case 'keyword':
      return readKeyword(node, reading);
    case 'optional':
      return readOptional(node, reading);
  }
};

/** Reads the parts of a spec in order, up to the one the cursor is in. */
function readNodes(nodes: readonly SpecNode[], reading: Reading): Outcome {
  for (const node of nodes) {
    const outcome = readNode(node, reading);

    if (outcome !== 'written') {
      return outcome;
    }
  }

  return 'written';
}

const keywordsOf = (nodes: readonly SpecNode[]): Keyword[] =>
  nodes.flatMap((node) => {
    switch (node.kind) {
      case 'slot':
        return [];
      case 'keyword':
        return [node.text];
      case 'optional':
        return keywordsOf(node.nodes);
    }
  });

/**
 * Finds where the end of the tokens is in the spec of a command: what can come next there.
 * The tokens are what is written of the command after its name, up to the cursor.
 */
export const matchSpec = (spec: CommandSpec, tokens: SpecToken[]): SpecPosition => {
  const reading: Reading = { tokens, index: 0, expected: [], keywords: new Set(keywordsOf(spec)) };
  const outcome = readNodes(spec, reading);

  // Tokens that are left over once everything is written do not belong to the spec.
  if (outcome === 'invalid' || (outcome === 'written' && !isAtCursor(reading))) {
    return INVALID;
  }

  return {
    expected: outcome === 'written' ? [...reading.expected, { kind: 'end' }] : reading.expected,
    isInvalid: false,
  };
};
