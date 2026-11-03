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
import {
  CodeCompletionCore,
  type CandidatesCollection,
  type RuleWithStartToken,
} from './code_completion_core';
import { COMMAND_RULES, PIPE_ANCHOR_RULE, PREFERRED_RULES } from './grammar_rules';
import type { CommandSegment, CursorLocation, ExpectedRule } from './types';

type ParseResult = ReturnType<typeof Parser.create>;
type EsqlParser = ParseResult['parser'];

interface GrammarInfo {
  ruleNames: string[];
  pipe: number;
  lp: number;
  rp: number;
  anchorRule: number;
  preferredRules: Set<number>;
  commandRules: Set<number>;
  lineComments: Set<number>;
  blockComments: Set<number>;
}

let grammarInfo: GrammarInfo | undefined;

const getGrammarInfo = (parser: EsqlParser): GrammarInfo => {
  if (grammarInfo) {
    return grammarInfo;
  }

  const { ruleNames, symbolicNames } = parser;
  const ruleIndexes = (names: readonly string[]) =>
    new Set(names.map((name) => ruleNames.indexOf(name)));
  // Each lexer mode has its own comment tokens, e.g. `FROM_LINE_COMMENT`.
  const lineComments = new Set<number>();
  const blockComments = new Set<number>();
  symbolicNames.forEach((name, type) => {
    if (name?.endsWith('MULTILINE_COMMENT')) {
      blockComments.add(type);
    } else if (name?.endsWith('LINE_COMMENT')) {
      lineComments.add(type);
    }
  });

  grammarInfo = {
    ruleNames,
    pipe: symbolicNames.indexOf('PIPE'),
    lp: symbolicNames.indexOf('LP'),
    rp: symbolicNames.indexOf('RP'),
    anchorRule: ruleNames.indexOf(PIPE_ANCHOR_RULE),
    preferredRules: ruleIndexes(PREFERRED_RULES),
    commandRules: ruleIndexes(COMMAND_RULES),
    lineComments,
    blockComments,
  };

  return grammarInfo;
};

const isVisible = (token: Token) => token.channel === Token.DEFAULT_CHANNEL;

/**
 * Lexer modes treat an unterminated `/*` differently (dropped, or lexed as `/` and `*`), so close
 * it and check whether a block comment now ends at the added `*\/`.
 */
const isInUnterminatedBlockComment = (
  textBeforeCursor: string,
  { blockComments }: GrammarInfo
): boolean => {
  if (!textBeforeCursor.includes('/*')) {
    return false;
  }
  const { tokens } = Parser.create(`${textBeforeCursor}*/`);
  tokens.fill();
  return tokens.tokens.some(
    ({ type, stop }) => blockComments.has(type) && stop + 1 === textBeforeCursor.length + 2
  );
};

/** Longest prefix shared by all stacks, comparing rule and start token. */
const commonPrefix = (stacks: RuleWithStartToken[][]): RuleWithStartToken[] => {
  const [first = [], ...rest] = stacks;
  let length = first.length;
  for (const stack of rest) {
    let index = 0;
    while (
      index < Math.min(length, stack.length) &&
      stack[index].ruleIndex === first[index].ruleIndex &&
      stack[index].startTokenIndex === first[index].startTokenIndex
    ) {
      index++;
    }
    length = index;
  }
  return first.slice(0, length);
};

/** The stack shared by all candidates, preferring the candidates found inside a command. */
const getSharedStack = (
  candidates: CandidatesCollection,
  { commandRules }: GrammarInfo
): RuleWithStartToken[] => {
  const stacks = [
    ...[...candidates.rules.values()].map(({ callStack }) => callStack),
    ...candidates.tokenCallStacks.values(),
  ];
  const inCommand = stacks.filter((stack) =>
    stack.some(({ ruleIndex }) => commandRules.has(ruleIndex))
  );

  return commonPrefix(inCommand.length ? inCommand : stacks);
};

const emptyLocation = (offset: number, inComment: boolean): CursorLocation => ({
  segment: { start: offset, end: offset, text: '' },
  ruleStack: [],
  expectedTokens: new Set(),
  expectedRules: [],
  commandCanEnd: false,
  inComment,
});

/**
 * Asks the grammar what can be typed at `offset`: the expected tokens and rule slots, the
 * innermost command around the cursor, and the word being typed.
 */
export const locateCursor = (text: string, offset: number): CursorLocation => {
  const textBeforeCursor = text.slice(0, offset);
  const { parser, tokens } = Parser.create(textBeforeCursor);
  tokens.fill();

  const grammar = getGrammarInfo(parser);
  const allTokens = tokens.tokens;
  const eof = allTokens[allTokens.length - 1];
  const lastToken: Token | undefined = allTokens[allTokens.length - 2];

  // The lexer emits nothing for an unterminated string or quoted name, so whatever follows the
  // last token is still being typed.
  const lexedEnd = lastToken ? lastToken.stop + 1 : 0;
  const untokenized = textBeforeCursor.slice(lexedEnd).trimStart();

  const inLineComment =
    lastToken !== undefined &&
    grammar.lineComments.has(lastToken.type) &&
    !/[\r\n]$/.test(lastToken.text);
  if (inLineComment || isInUnterminatedBlockComment(textBeforeCursor, grammar)) {
    return emptyLocation(offset, true);
  }

  // The caret is the word being typed when the cursor touches one, otherwise the next token.
  const isTypingWord =
    !untokenized &&
    lastToken !== undefined &&
    isVisible(lastToken) &&
    lastToken.stop + 1 === offset &&
    /\w$/.test(lastToken.text);
  const caret = isTypingWord ? lastToken : eof;

  let partial: CursorLocation['partial'];
  if (isTypingWord) {
    partial = { text: lastToken.text, start: lastToken.start };
  } else if (untokenized) {
    partial = { text: untokenized, start: offset - untokenized.length };
  }

  // Lexical nesting only: a pipe inside parentheses belongs to a nested query, which is part
  // of the enclosing command.
  const depthAt: number[] = [];
  let depth = 0;
  for (let index = 0; index < caret.tokenIndex; index++) {
    const { type } = allTokens[index];
    if (type === grammar.lp) {
      depth++;
    } else if (type === grammar.rp) {
      depth = Math.max(0, depth - 1);
    }
    depthAt[index] = depth;
  }

  const core = new CodeCompletionCore(parser, tokens);
  core.preferredRules = grammar.preferredRules;

  let candidates: CandidatesCollection | undefined;
  let anchorToken: Token | undefined;
  for (let index = caret.tokenIndex - 1; index >= 0; index--) {
    if (allTokens[index].type !== grammar.pipe || depthAt[index] !== 0) {
      continue;
    }
    const start = allTokens[index + 1];
    const collected = core.collectCandidates(caret.tokenIndex, {
      ruleIndex: grammar.anchorRule,
      start,
    });
    // The grammar accepted this anchor.
    if (collected.tokens.size || collected.rules.size || collected.startRuleCanEndAtCaret) {
      candidates = collected;
      anchorToken = allTokens.slice(index + 1).find(isVisible);
      break;
    }
  }
  if (!candidates) {
    candidates = core.collectCandidates(caret.tokenIndex);
  }

  const expectedTokens = new Set(candidates.tokens.keys());
  let commandCanEnd: boolean;
  if (anchorToken) {
    commandCanEnd = candidates.startRuleCanEndAtCaret;
    // The anchored walk stops at the end of the command, so add what may follow one.
    if (commandCanEnd) {
      expectedTokens.add(grammar.pipe);
      expectedTokens.add(depth === 0 ? Token.EOF : grammar.rp);
    }
  } else {
    commandCanEnd = expectedTokens.has(grammar.pipe);
  }

  const { ruleNames } = grammar;
  const expectedRules: ExpectedRule[] = [...candidates.rules].map(
    ([ruleIndex, { callStack, startTokenIndex }]) => ({
      rule: ruleNames[ruleIndex],
      stack: callStack.map((entry) => ruleNames[entry.ruleIndex]),
      continuation: startTokenIndex < caret.tokenIndex,
    })
  );

  const sharedStack = getSharedStack(candidates, grammar);
  const command = sharedStack.findLast(({ ruleIndex }) => grammar.commandRules.has(ruleIndex));
  const commandToken =
    (command && allTokens[command.startTokenIndex]) ??
    anchorToken ??
    allTokens.find(isVisible) ??
    eof;
  const segmentStart = commandToken.type === Token.EOF ? offset : commandToken.start;
  const segment: CommandSegment = {
    start: segmentStart,
    end: offset,
    text: textBeforeCursor.slice(segmentStart),
  };

  return {
    segment,
    ruleStack: sharedStack.map(({ ruleIndex }) => ruleNames[ruleIndex]),
    expectedTokens,
    expectedRules,
    commandCanEnd,
    partial,
    inComment: false,
  };
};
