/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Parser } from '@elastic/esql';
import { classifyToken, getTokenText } from '../cursor_ir/token_classes';
import type { TokenClass } from '../cursor_ir/types';
import { RULE_TRANSITION, TOKEN_TRANSITIONS } from '../grammar_labels/extract_grammar_labels';

/** A token that can come right after another one. */
export interface SuccessorToken {
  /** The grammar name of the token, e.g. `FIRST`. */
  token: string;
  class: TokenClass;
  /** The fixed text of the token; absent for a name, a number or a string. */
  text?: string;
}

/** What the grammar allows right after a token, inside the rule that takes the token. */
export interface TokenSuccessors {
  /** The tokens that can come next, also as the first token of a rule that is called next. */
  tokens: SuccessorToken[];
  /** The rule can end right after the token: nothing has to follow it. */
  canEnd: boolean;
}

interface State {
  stateNumber: number;
  ruleIndex: number;
  transitions: Array<{
    serializationType: number;
    target: State;
    followState?: State;
    label?: { intervals: Array<{ start: number; stop: number }> };
  }>;
}

interface Grammar {
  states: State[];
  ruleToStartState: State[];
  ruleToStopState: State[];
  ruleNames: string[];
  symbolicNames: Array<string | null>;
}

const NOT_SET_TRANSITION = 8;

let grammar: Grammar | undefined;

const getGrammar = (): Grammar => {
  if (!grammar) {
    const { parser } = Parser.create('');
    // `atn` exists on every antlr4 recognizer at runtime but is missing from its typings.
    const { atn } = parser as unknown as { atn: Omit<Grammar, 'ruleNames' | 'symbolicNames'> };

    grammar = {
      states: atn.states,
      ruleToStartState: atn.ruleToStartState,
      ruleToStopState: atn.ruleToStopState,
      ruleNames: parser.ruleNames,
      symbolicNames: parser.symbolicNames,
    };
  }

  return grammar;
};

const tokenTypesOf = ({ serializationType, label }: State['transitions'][number]): number[] => {
  if (!TOKEN_TRANSITIONS.includes(serializationType) || serializationType === NOT_SET_TRANSITION) {
    return [];
  }

  return (label?.intervals ?? []).flatMap(({ start, stop }) =>
    Array.from({ length: stop - start }, (_, offset) => start + offset)
  );
};

/**
 * The token types reachable from a state before any other token, and whether the end of the
 * state's rule is. A rule that is called is entered for its first tokens; when it can be
 * empty, what follows the call counts too.
 */
const collect = (start: State, types: Set<number>, visited: Set<number>): boolean => {
  const { ruleToStopState } = getGrammar();
  const pending = [start];
  let reachesEnd = false;

  while (pending.length) {
    const state = pending.pop();

    if (!state || visited.has(state.stateNumber)) {
      continue;
    }
    visited.add(state.stateNumber);

    if (ruleToStopState[state.ruleIndex] === state) {
      reachesEnd = true;
      continue;
    }

    for (const transition of state.transitions) {
      const taken = tokenTypesOf(transition);

      if (transition.serializationType === RULE_TRANSITION) {
        // A called rule that can be empty lets what follows the call come first too.
        if (collect(transition.target, types, visited) && transition.followState) {
          pending.push(transition.followState);
        }
      } else if (taken.length) {
        taken.forEach((type) => types.add(type));
      } else if (!TOKEN_TRANSITIONS.includes(transition.serializationType)) {
        pending.push(transition.target);
      }
    }
  }

  return reachesEnd;
};

const cache = new Map<string, TokenSuccessors>();

/**
 * What can come right after a token in a rule, read from the grammar: `FIRST` or `LAST` after
 * `NULLS`, an opening brace after `WITH`, nothing required after `ASC`.
 */
export const getTokenSuccessors = (rule: string, token: string): TokenSuccessors => {
  const key = `${rule}>${token}`;
  const cached = cache.get(key);

  if (cached) {
    return cached;
  }

  const { states, ruleNames, symbolicNames } = getGrammar();
  const ruleIndex = ruleNames.indexOf(rule);
  const tokenType = symbolicNames.indexOf(token);
  const types = new Set<number>();
  let canEnd = false;

  for (const state of states) {
    if (state?.ruleIndex !== ruleIndex) {
      continue;
    }
    for (const transition of state.transitions) {
      if (tokenTypesOf(transition).includes(tokenType)) {
        canEnd = collect(transition.target, types, new Set()) || canEnd;
      }
    }
  }

  const successors: TokenSuccessors = {
    tokens: [...types].map((type) => ({
      token: symbolicNames[type] ?? String(type),
      class: classifyToken(type, false),
      text: getTokenText(type),
    })),
    canEnd,
  };
  cache.set(key, successors);

  return successors;
};
