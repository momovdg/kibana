/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { PromQLParser } from '@elastic/esql';
import { Token } from 'antlr4';
import { CodeCompletionCore } from '../code_completion/code_completion_core';

/** A rule of the PromQL grammar that can start at the cursor. */
export interface PromqlExpectedRule {
  /** The rule, e.g. `labelName`. */
  rule: string;
  /** The rules it is reached through, outermost first, e.g. `['expression', 'selector']`. */
  path: string[];
}

/** A token with a fixed text that can come at the cursor. */
export interface PromqlFollower {
  /** The grammar name of the token, e.g. `BY`. */
  token: string;
  /** Its text, e.g. `by`. */
  text: string;
  /** The rules above the one that takes it, outermost first. */
  path: string[];
}

/** A pair of round brackets in a query. */
export interface PromqlBracket {
  /**
   * The word before the bracket: the name of a function, a keyword as `by`, or nothing for
   * brackets around an expression.
   */
  name: string;
  /** How many separators are written directly in it: the index of the item at the cursor. */
  argument: number;
}

/** What the PromQL grammar says about a cursor in a PromQL text. */
export interface PromqlCursor {
  rules: PromqlExpectedRule[];
  followers: PromqlFollower[];
  /** The word being typed; the rules and followers describe the place before it. */
  word?: { text: string; start: number };
  /** The text is a whole query at the cursor. */
  canEnd: boolean;
  /** The brackets that are open at the cursor, outermost first. */
  open: PromqlBracket[];
  /** The bracket that closes right before the cursor. */
  closed?: PromqlBracket;
  /** The text of the last token before the cursor or the word being typed. */
  previous?: string;
}

// The rules reported as a whole: the leaves of the grammar a query is made of. What they
// are (a metric, the name of a function, a label) is read from the rules around them.
const REPORTED_RULES: readonly string[] = [
  'identifier',
  'labelName',
  'labelValue',
  'duration',
  'timeValue',
  'number',
  'string',
];

const WORD_END = /[\w.:]$/;
const WORD = /^[A-Za-z_][\w.:]*$/;
// The keywords a list of labels in brackets follows.
const LABEL_LIST_KEYWORDS: readonly string[] = ['by', 'without', 'on', 'ignoring'];

const isFunctionName = ({ name }: { name: string }): boolean =>
  name !== '' && !LABEL_LIST_KEYWORDS.includes(name.toLowerCase());
const OPENER = '(';
const CLOSER = ')';
const SEPARATOR = ',';
const OTHER_OPENERS: readonly string[] = ['{', '['];
const OTHER_CLOSERS: readonly string[] = ['}', ']'];

type GeneratedParser = InstanceType<typeof PromQLParser>['parser'];

interface Vocabulary {
  ruleNames: string[];
  symbolicNames: Array<string | null>;
  literalNames: Array<string | null>;
}

const vocabularyOf = (parser: GeneratedParser): Vocabulary => parser as unknown as Vocabulary;

/**
 * Describes the cursor at `offset` of a PromQL text in terms of the PromQL grammar: the rules
 * that can start there and the tokens that can come. It uses the same walk over the grammar
 * as the ES|QL locator, on the PromQL parser.
 */
export const locatePromql = (text: string, offset: number): PromqlCursor => {
  const before = text.slice(0, offset);
  const { parser, tokens: stream } = PromQLParser.create(before);
  stream.fill();

  const { ruleNames, symbolicNames, literalNames } = vocabularyOf(parser);
  const tokens = (stream as unknown as { tokens: Token[] }).tokens;
  const visible = tokens.filter(({ channel }) => channel === Token.DEFAULT_CHANNEL);
  const last = visible.filter(({ type }) => type !== Token.EOF).at(-1);
  const isTypingWord = last !== undefined && last.stop + 1 === offset && WORD_END.test(before);
  const caret = isTypingWord ? last : visible[visible.length - 1];

  const core = new CodeCompletionCore(
    parser as unknown as ConstructorParameters<typeof CodeCompletionCore>[0],
    stream as unknown as ConstructorParameters<typeof CodeCompletionCore>[1]
  );
  core.preferredRules = new Set(REPORTED_RULES.map((rule) => ruleNames.indexOf(rule)));

  const candidates = core.collectCandidates(caret.tokenIndex);
  const written = visible.filter(
    ({ type, tokenIndex }) => type !== Token.EOF && tokenIndex < caret.tokenIndex
  );
  const open: PromqlBracket[] = [];
  let closed: PromqlBracket | undefined;
  // Braces and square brackets have separators of their own.
  let nested = 0;

  // Where each open bracket starts, to find the word a list of labels follows.
  const starts: number[] = [];
  let closedStart: number | undefined;

  written.forEach(({ text: tokenText }, index) => {
    const justClosed = closed;
    closed = undefined;
    if (tokenText === OPENER) {
      const leading = written[index - 1]?.text ?? '';
      // The brackets of a function can come after its list of labels: `sum by (a) (`.
      const owner =
        leading === CLOSER && justClosed && closedStart !== undefined && !isFunctionName(justClosed)
          ? written[closedStart - 2]?.text ?? ''
          : leading;

      open.push({ name: WORD.test(owner) ? owner : '', argument: 0 });
      starts.push(index);
    } else if (tokenText === CLOSER) {
      closed = open.pop();
      closedStart = starts.pop();
    } else if (OTHER_OPENERS.includes(tokenText)) {
      nested++;
    } else if (OTHER_CLOSERS.includes(tokenText)) {
      nested = Math.max(0, nested - 1);
    } else if (tokenText === SEPARATOR && nested === 0 && open.length > 0) {
      open[open.length - 1].argument++;
    }
  });
  const namesOf = (stack: Array<{ ruleIndex: number }>): string[] =>
    stack.map(({ ruleIndex }) => ruleNames[ruleIndex]);

  return {
    rules: [...candidates.rules].flatMap(([ruleIndex, entries]) =>
      entries.map(({ callStack }) => ({ rule: ruleNames[ruleIndex], path: namesOf(callStack) }))
    ),
    followers: [...candidates.tokens.keys()].flatMap((type) => {
      const literal = literalNames[type];

      // A token with no fixed text is a value: the rules say which.
      return literal
        ? [
            {
              token: symbolicNames[type] ?? literal,
              text: literal.slice(1, -1),
              path: namesOf(candidates.tokenCallStacks.get(type) ?? []),
            },
          ]
        : [];
    }),
    ...(isTypingWord && { word: { text: last.text, start: last.start } }),
    // A whole query is one the grammar lets end here.
    canEnd: candidates.tokens.has(Token.EOF),
    open,
    ...(closed !== undefined && { closed }),
    ...(written.length > 0 && { previous: written[written.length - 1].text }),
  };
};
