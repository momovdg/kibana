/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { CommandSpec, SlotNode, SpecNode } from './types';

/** A token of the command, as the matcher needs it. */
export interface SpecToken {
  text: string;
  start: number;
  end: number;
}

/** What is written for a slot. */
export interface FilledSlot {
  slot: SlotNode;
  text: string;
  start: number;
  end: number;
}

/** What the spec allows at the cursor. */
export type Expected =
  | { kind: 'keyword'; text: string }
  | { kind: 'symbol'; text: string }
  | { kind: 'slot'; slot: SlotNode }
  | { kind: 'end' };

/** Where the cursor is in the spec of a command. */
export interface SpecPosition {
  /** What can come at the cursor, in the order of the spec. */
  expected: Expected[];
  /** The slots that are written, in order. */
  filled: FilledSlot[];
  /** The slot the last thing written belongs to, when it can still go on, as an expression. */
  open?: FilledSlot;
  /** The text does not follow the spec: nothing is offered. */
  isInvalid: boolean;
}

const OPENERS = ['(', '[', '{'];
const CLOSERS = [')', ']', '}'];
const SYMBOLS = [',', '='];

const isText = (token: SpecToken | undefined, text: string): boolean =>
  token?.text.toUpperCase() === text.toUpperCase();

/** Every keyword of a spec: an expression stops where one of them is written outside brackets. */
const keywordsOf = (nodes: SpecNode[]): string[] =>
  nodes.flatMap((node) => {
    if (node.kind === 'keyword') {
      return [node.text];
    }

    return node.kind === 'optional' || node.kind === 'repeat' ? keywordsOf(node.nodes) : [];
  });

/** What a sequence can start with, through what may be left out. */
const firstOf = (nodes: SpecNode[]): Expected[] => {
  const expected: Expected[] = [];

  for (const node of nodes) {
    if (node.kind === 'optional') {
      expected.push(...firstOf(node.nodes));
      continue;
    }

    expected.push(...(node.kind === 'repeat' ? firstOf(node.nodes) : [toExpected(node)]));
    break;
  }

  return expected;
};

const toExpected = (node: Exclude<SpecNode, { kind: 'optional' | 'repeat' }>): Expected =>
  node.kind === 'slot' ? { kind: 'slot', slot: node } : { kind: node.kind, text: node.text };

/** Whether a token can start what an optional part holds. */
const starts = (
  nodes: SpecNode[],
  tokens: SpecToken[],
  index: number,
  stops: string[]
): boolean => {
  const [first, second] = nodes;

  // An assignment is there when the symbol follows the name.
  if (first?.kind === 'slot' && second?.kind === 'symbol') {
    return isText(tokens[index + 1], second.text);
  }

  // A value is there unless a keyword of the command is written in its place; a keyword or a
  // symbol is there when it is the one written.
  return firstOf(nodes).some((expected) =>
    expected.kind === 'slot'
      ? !stops.includes(tokens[index].text.toUpperCase())
      : expected.kind !== 'end' && isText(tokens[index], expected.text)
  );
};

/**
 * Finds where the end of the tokens is in the spec of a command. The tokens are what is
 * written of the command after its name, up to the cursor, without the word being typed.
 */
export const matchSpec = (spec: CommandSpec, tokens: SpecToken[]): SpecPosition => {
  const stops = keywordsOf(spec);
  const position: SpecPosition = { expected: [], filled: [], isInvalid: false };
  let isBlocked = false;

  /** The index after the value of a slot: one word, or everything up to what ends a list. */
  const endOfValue = ({ role, list }: SlotNode, from: number): number => {
    const isOpenEnded = role.kind === 'expression' || list === true;
    let depth = 0;
    let index = from;

    while (index < tokens.length) {
      const { text, start } = tokens[index];
      const isGlued = index > from && start === tokens[index - 1].end;

      if (
        depth === 0 &&
        (stops.includes(text.toUpperCase()) || (!isOpenEnded && !isGlued && index > from))
      ) {
        break;
      }
      if (depth === 0 && !isOpenEnded && SYMBOLS.includes(text)) {
        break;
      }
      // One expression of a list ends at the comma before the next one.
      if (depth === 0 && !list && text === ',') {
        break;
      }

      depth += OPENERS.includes(text) ? 1 : CLOSERS.includes(text) ? -1 : 0;
      index++;
    }

    return index;
  };

  const walk = (nodes: SpecNode[], from: number): number => {
    let index = from;

    for (const node of nodes) {
      if (isBlocked || position.isInvalid) {
        return index;
      }
      // The tokens are used up: what comes next is what this node starts with.
      if (index >= tokens.length) {
        if (node.kind === 'optional') {
          position.expected.push(...firstOf(node.nodes));
          continue;
        }

        position.expected.push(...firstOf([node]));
        isBlocked = true;

        return index;
      }

      switch (node.kind) {
        case 'keyword':
        case 'symbol':
          if (!isText(tokens[index], node.text)) {
            position.isInvalid = true;

            return index;
          }
          index++;
          break;
        case 'slot': {
          const end = endOfValue(node, index);

          if (end === index) {
            position.isInvalid = true;

            return index;
          }

          const filled: FilledSlot = {
            slot: node,
            text: tokens
              .slice(index, end)
              .map(({ text }) => text)
              .join(' '),
            start: tokens[index].start,
            end: tokens[end - 1].end,
          };
          position.filled.push(filled);
          index = end;

          // An expression, or a list read as one, can go on where the tokens end.
          if (index >= tokens.length && (node.role.kind === 'expression' || node.list)) {
            position.open = filled;
          }
          break;
        }
        case 'optional':
          if (starts(node.nodes, tokens, index, stops)) {
            index = walk(node.nodes, index);
          }
          break;
        case 'repeat':
          for (;;) {
            index = walk(node.nodes, index);
            if (isBlocked || position.isInvalid) {
              return index;
            }
            if (index >= tokens.length) {
              position.expected.push({ kind: 'symbol', text: ',' });
              break;
            }
            if (!isText(tokens[index], ',')) {
              break;
            }
            index++;
            if (index >= tokens.length) {
              position.expected.push(...firstOf(node.nodes));
              isBlocked = true;

              return index;
            }
          }
          break;
      }
    }

    return index;
  };

  const end = walk(spec, 0);

  if (!isBlocked && !position.isInvalid) {
    // Everything that had to be written is: the command can end, unless tokens are left over.
    position.isInvalid = end < tokens.length;
    // A command is never only its name: nothing written, nothing to end.
    if (tokens.length > 0) {
      position.expected.push({ kind: 'end' });
    }
  }

  return position;
};
