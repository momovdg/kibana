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
  getCommandRuleNames,
  getTokenName,
  locateCursor,
} from '../cursor_location/cursor_location';
import type { CursorLocation } from '../cursor_location/types';
import { callSiteId } from './call_site_id';
import { describeCommands, describeParsed, type SyntaxTreeGetter } from './describe_commands';
import { getCommandWindow, type CommandWindow } from './window';
import { classifyToken, getTokenText, isExpressionRule } from './token_classes';
import type {
  CallSiteId,
  CursorIR,
  CursorPosition,
  ExpectedArgument,
  Follower,
  NextToken,
  PreviousToken,
  TokenClass,
  TypedWord,
  WordKind,
  WrittenArgument,
  WrittenCommand,
} from './types';

/** A chain of rules, outermost first, with the ATN state that called each one when known. */
interface RuleChain {
  rules: string[];
  invokingStates: Array<number | undefined>;
}

/** The innermost command of a chain, and the call sites from that command down to its end. */
const describeChain = ({
  rules,
  invokingStates,
}: RuleChain): { command?: string; enclosingCommands: string[]; path: CallSiteId[] } => {
  const commandRules = getCommandRuleNames();
  const commandIndexes = rules.flatMap((rule, index) =>
    commandRules.includes(rule) ? [index] : []
  );
  const commandIndex = commandIndexes.at(-1) ?? -1;
  const path: CallSiteId[] = [];

  // Without a command the chain starts at a rule that only chooses one, which is no call site.
  for (let index = Math.max(commandIndex, 0) + 1; index < rules.length; index++) {
    path.push(callSiteId(rules[index - 1], rules[index], invokingStates[index]));
  }

  return {
    command: rules[commandIndex],
    enclosingCommands: commandIndexes.slice(0, -1).map((index) => rules[index]),
    path,
  };
};

const toArguments = ({ expectedRules }: CursorLocation): ExpectedArgument[] => {
  const byKey = new Map<string, ExpectedArgument>();

  for (const { rule, stack, invokingStates = [], continuation } of expectedRules) {
    const { command, path } = describeChain({ rules: [...stack, rule], invokingStates });
    const id = path.at(-1) ?? rule;
    const key = `${command}|${path.join('/')}|${continuation}`;

    if (!byKey.has(key)) {
      byKey.set(key, { id, rule, path, command, continues: continuation });
    }
  }

  return [...byKey.values()];
};

const toFollowers = ({ expectedTokens, tokenStacks }: CursorLocation): Follower[] =>
  [...expectedTokens].map((type) => {
    const token = getTokenName(type);
    const text = getTokenText(type);
    const stack = tokenStacks.get(type);

    // A token with no stack is one the end of the command allows: a pipe or the end of the query.
    if (!stack) {
      return { token, class: classifyToken(type, false), text, path: [], startsCommand: false };
    }

    const { command, path } = describeChain(stack);
    const inExpression = stack.rules
      .slice(command ? stack.rules.lastIndexOf(command) + 1 : 0)
      .some(isExpressionRule);
    // The name of a command is taken by the rule of that command, whose call is no argument.
    const owner = stack.startsCommand ? stack.command : stack.rules.at(-1);

    return {
      token,
      class: classifyToken(type, inExpression),
      text,
      id: `${owner}>${token}`,
      path: stack.startsCommand ? [] : path,
      command: stack.startsCommand ? stack.command : command,
      startsCommand: stack.startsCommand,
    };
  });

const toPrevious = ({
  previousTokenType,
  whitespaceBefore,
}: CursorLocation): PreviousToken | undefined =>
  previousTokenType === undefined || previousTokenType === Token.EOF
    ? undefined
    : {
        token: getTokenName(previousTokenType),
        class: classifyToken(previousTokenType, false),
        glued: !whitespaceBefore,
      };

const wordKind = (text: string): WordKind => {
  if (text.startsWith('"')) {
    return 'string';
  }
  if (text.startsWith('`')) {
    return 'quoted_name';
  }
  if (/^[+-]?\.?\d/.test(text)) {
    return 'number';
  }

  return text.includes('*') ? 'pattern' : 'name';
};

const toWord = (
  { partial, expectedRules, whitespaceBefore }: CursorLocation,
  followers: Follower[],
  text: string,
  offset: number
): TypedWord | undefined => {
  if (!partial) {
    return undefined;
  }

  const spelled = followers.find((follower) => follower.text === partial.text.toLowerCase());
  // The word continues an argument when it is glued to what comes before, as `b` in `a.b`.
  // That argument started before the word, at the earliest slot the word would extend.
  const starts = whitespaceBefore
    ? []
    : expectedRules
        .filter(({ continuation, start }) => continuation && start < partial.start)
        .map(({ start }) => start);

  return {
    ...partial,
    kind: wordKind(partial.text),
    ...(spelled && { keyword: spelled.token }),
    ...(starts.length && {
      argument: { text: text.slice(Math.min(...starts), offset), start: Math.min(...starts) },
    }),
  };
};

/** The first visible token that starts at or after `from`. */
const toNext = (text: string, from: number): NextToken | undefined => {
  if (!text.slice(from).trim()) {
    return undefined;
  }

  const { tokens } = Parser.create(text);
  tokens.fill();
  const next = tokens.tokens.find(
    ({ type, channel, start }) =>
      type !== Token.EOF && channel === Token.DEFAULT_CHANNEL && start >= from
  );

  return next && { token: getTokenName(next.type), class: classifyToken(next.type, false) };
};

// A name no query contains, which the lexer reads as a name or a value in every mode.
// The same text the editor's own parse marks the cursor with, so one cleaner serves both.
const CURSOR_MARKER = 'marker_esql_editor';
const CLOSER_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The brackets that are open at the end of the text, innermost last. */
const openBrackets = (textBefore: string): string[] => {
  const { tokens } = Parser.create(textBefore);
  tokens.fill();
  const open: string[] = [];

  for (const { type, channel } of tokens.tokens) {
    if (channel !== Token.DEFAULT_CHANNEL) {
      continue;
    }

    const tokenClass = classifyToken(type, false);
    if (tokenClass === 'opener') {
      open.push(getTokenText(type) ?? '(');
    } else if (tokenClass === 'closer') {
      open.pop();
    }
  }

  return open;
};

/**
 * The commands written before the cursor, with what is written in each.
 *
 * The parser recovers from an unfinished command by guessing, which can rearrange what was
 * written. So the text is finished first with what the grammar expects at the cursor: a name
 * where an argument or a value can come, then the brackets that are still open. Whatever the
 * parser reads from the added text is left out again.
 */
// The commands before the one at the cursor do not change while that one is typed: they are
// described once per text.
let earlierCommands: { text: string; commands: WrittenCommand[] } | undefined;

const describeEarlier = (text: string): WrittenCommand[] => {
  if (earlierCommands?.text !== text) {
    earlierCommands = { text, commands: describeCommands(text) };
  }

  return earlierCommands.commands;
};

const toCommands = (
  textBefore: string,
  requiredTokens: string,
  placeholder: string,
  { earlier, lastPipe = 0 }: CommandWindow
): { commands: WrittenCommand[]; getSyntaxTree: SyntaxTreeGetter } => {
  const caret = textBefore.length;
  const unfinished = `${textBefore}${requiredTokens}`;
  const closers = openBrackets(unfinished)
    .reverse()
    .map((opener) => CLOSER_OF[opener] ?? '')
    .join('');
  const finished = `${unfinished}${placeholder}${closers}`;
  const expectsValue = placeholder !== '';

  // Where commands were blanked out, their description comes from their own text.
  const parsed = describeParsed(finished);
  const described =
    earlier === undefined
      ? parsed.commands
      : [...describeEarlier(earlier), ...parsed.commands.filter(({ start }) => start > lastPipe)];
  const commands = described
    .filter(({ start }) => start < caret)
    .map((command) => ({
      ...command,
      end: Math.min(command.end, caret),
      arguments: command.arguments
        .filter(({ start }) => start < caret)
        .map((argument) => ({
          ...argument,
          text: argument.text.slice(0, caret - argument.start),
          end: Math.min(argument.end, caret),
          ...(argument.end > caret && { open: true }),
          ancestors: argument.ancestors.map((ancestor) => ({
            ...ancestor,
            end: Math.min(ancestor.end, caret),
            open: ancestor.end > caret || (ancestor.end === caret && !expectsValue),
          })),
        })),
    }));

  return { commands, getSyntaxTree: parsed.getSyntaxTree };
};

const COMPLETE: readonly TokenClass[] = ['value', 'closer'];

const toPosition = (
  location: CursorLocation,
  expected: ExpectedArgument[],
  followers: Follower[],
  previous: PreviousToken | undefined
): CursorPosition => {
  if (location.inComment) {
    return 'inside_comment';
  }
  // The lexer makes no token of an unterminated string, so its text is still the word typed.
  if (location.partial?.text.startsWith('"') && !location.partial.complete) {
    return 'inside_string';
  }
  if (!expected.length && !followers.length) {
    return 'invalid';
  }
  // A word the lexer made no token of, as a name where only keywords can be written: what is
  // expected was read from before the word, and no longer holds after it.
  if (/\w/.test(location.skippedText)) {
    return 'invalid';
  }
  if (followers.some(({ startsCommand }) => startsCommand)) {
    if (!previous) {
      return 'start_of_query';
    }

    return previous.class === 'terminator' ? 'start_of_statement' : 'start_of_command';
  }
  if (expected.length && expected.every(({ continues }) => continues) && !followers.length) {
    return 'inside_argument';
  }

  return previous && COMPLETE.includes(previous.class) ? 'after_argument' : 'start_of_argument';
};

interface Expectation {
  position: CursorPosition;
  expected: ExpectedArgument[];
  followers: Follower[];
}

// After a complete argument nothing has to follow, so nothing is added.
const expectsValue = ({ position, expected, followers }: Expectation): boolean =>
  position !== 'after_argument' &&
  (expected.length > 0 || followers.some((follower) => follower.class === 'value'));

// The tokens after which the text could stop or go on freely: none of them is required.
const OPTIONAL: readonly TokenClass[] = ['end', 'pipe', 'closer', 'separator', 'terminator'];
const MAX_REQUIRED_TOKENS = 4;

const MAP_OPENER = '{';
// The rules that take a literal and never a name.
const LITERAL_RULES: readonly string[] = ['string', 'constant', 'integerValue', 'parameter'];
const STRING_RULE = 'string';

/**
 * What stands for the value the grammar expects at the end of the text. A name fits wherever
 * a name can come; where only a literal can, as after the match operator or in a map, a
 * string or a number does.
 */
export const getValuePlaceholder = (expected: ExpectedArgument[]): string => {
  const rules = expected.map(({ rule }) => rule);

  if (!rules.length || rules.some((rule) => !LITERAL_RULES.includes(rule))) {
    return CURSOR_MARKER;
  }

  return rules.every((rule) => rule === STRING_RULE) ? `"${CURSOR_MARKER}"` : '0';
};

/**
 * The text with the tokens the grammar requires next, as `IN (` after `a NOT`. Where the text
 * stops on a token that needs another one, the parser cannot read the command at all, and
 * what is written of it would be lost. Inside a map a name alone is not enough either: an
 * entry is a name, a colon and a value, so each is added in turn.
 */
const withRequiredTokens = (
  textBefore: string,
  expectation: Expectation
): { text: string; placeholder: string } => {
  let text = textBefore;
  let current = expectation;
  const isInMap = textBefore.includes(MAP_OPENER) && openBrackets(textBefore).at(-1) === MAP_OPENER;

  for (let added = 0; added < MAX_REQUIRED_TOKENS; added++) {
    const [required] = current.followers;
    const needsMapValue = isInMap && expectsValue(current);
    // A token can be required after a value too: the colon after the name of a map entry,
    // or `AS` or `=` after the first name of a rename.
    const isRequired =
      (current.position === 'start_of_argument' || current.position === 'after_argument') &&
      !expectsValue(current) &&
      required?.text !== undefined &&
      current.followers.every((follower) => !OPTIONAL.includes(follower.class));

    if (!needsMapValue && !isRequired) {
      break;
    }

    text = `${text} ${needsMapValue ? getValuePlaceholder(current.expected) : required.text} `;
    const location = locateCursor(text, text.length);
    const expected = toArguments(location);
    const followers = toFollowers(location);

    current = {
      position: toPosition(location, expected, followers, toPrevious(location)),
      expected,
      followers,
    };
  }

  return { text, placeholder: expectsValue(current) ? getValuePlaceholder(current.expected) : '' };
};

/**
 * What is written in the command the cursor is in: the last command to start whose text
 * reaches the cursor. A command that is closed before the cursor, as a subquery, does not.
 */
const getInnermost = (
  commands: WrittenCommand[],
  textBefore: string
): WrittenArgument[] | undefined =>
  commands
    .filter(({ end }) => textBefore.slice(end).trim() === '')
    .reduce<WrittenCommand | undefined>(
      (innermost, command) =>
        !innermost || command.start >= innermost.start ? command : innermost,
      undefined
    )?.arguments;

/** The most frequent value, so a stray candidate does not decide the command. */
const mostFrequent = (values: Array<string | undefined>): string | undefined => {
  const counts = new Map<string, number>();

  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts].sort(([, first], [, second]) => second - first)[0]?.[0];
};

/** What the grammar expects at a cursor, without what is written before it. */
export type ExpectedAtCursor = Pick<CursorIR, 'position' | 'arguments' | 'followers'>;

/**
 * What the grammar expects at `offset`: the position, the arguments and the tokens that can
 * come. It reads no written argument, so it costs a part of what `locate` does: for asking
 * what would follow a text that is not the query, as a name put at the cursor.
 */
export const locateExpected = (text: string, offset: number): ExpectedAtCursor => {
  const location = locateCursor(text, offset);
  const expected = toArguments(location);
  const followers = toFollowers(location);

  return {
    position: toPosition(location, expected, followers, toPrevious(location)),
    arguments: expected,
    followers,
  };
};

/**
 * Describes the cursor at `offset` in terms of the grammar: where it is, which arguments and
 * tokens can come next, and the word being typed. It knows no command by name.
 */
export const locate = (fullText: string, offset: number): CursorIR =>
  // The text is read with the commands the cursor is not in blanked out.
  locateThrough(fullText, offset, getCommandWindow(fullText.slice(0, offset)));

const syntaxTrees = new WeakMap<CursorIR, SyntaxTreeGetter>();

/**
 * The syntax tree of the text `locate` read for a cursor: the text before the cursor, finished
 * so that it parses, with the commands the cursor is not in blanked out. It comes from the
 * parse `locate` made, so asking for it parses nothing.
 */
export const getSyntaxTree = (ir: CursorIR): ReturnType<SyntaxTreeGetter> | undefined =>
  syntaxTrees.get(ir)?.();

/**
 * The same as `locate`, reading every command of the text. It is what `locate` has to agree
 * with, and it is slower by the length of the query: tests compare the two.
 */
export const locateWholeText = (fullText: string, offset: number): CursorIR =>
  locateThrough(fullText, offset, { text: fullText.slice(0, offset) });

const locateThrough = (fullText: string, offset: number, window: CommandWindow): CursorIR => {
  const text = `${window.text}${fullText.slice(offset)}`;
  const location = locateCursor(text, offset);
  const expected = toArguments(location);
  const followers = toFollowers(location);
  const previous = toPrevious(location);
  const shared = describeChain({ rules: location.ruleStack, invokingStates: [] });
  // Inside a branch the candidates agree on the command while their shared rules stop above it.
  const command =
    mostFrequent([
      ...expected.map((argument) => argument.command),
      ...followers
        .filter(({ startsCommand }) => !startsCommand)
        .map((follower) => follower.command),
    ]) ?? shared.command;

  const word = toWord(location, followers, text, offset);
  // What is written ends where the word being typed starts.
  const caret = word?.start ?? offset;
  const onlyFollower = followers.length === 1 && !expected.length ? followers[0].token : undefined;

  const position = toPosition(location, expected, followers, previous);

  const textBefore = text.slice(0, caret);
  const required = location.inComment
    ? { text: textBefore, placeholder: '' }
    : withRequiredTokens(textBefore, { position, expected, followers });
  const described = location.inComment
    ? undefined
    : toCommands(textBefore, required.text.slice(caret), required.placeholder, window);
  const commands = described?.commands ?? [];
  const written = getInnermost(commands, textBefore) ?? [];

  const ir: CursorIR = {
    position,
    command,
    enclosingCommands:
      command && command !== shared.command
        ? [...shared.enclosingCommands, ...(shared.command ? [shared.command] : [])]
        : shared.enclosingCommands,
    // The text of the segment is the one written, also where commands were blanked out.
    segment: {
      ...location.segment,
      text: fullText.slice(location.segment.start, offset),
    },
    previous,
    arguments: expected,
    followers,
    canEnd: location.commandCanEnd,
    ...(onlyFollower && { onlyFollower }),
    word,
    next: toNext(text, offset),
    written,
    commands,
  };

  // Tokens the grammar requires after the cursor change the shape of what is written: the
  // syntax tree is given only where none was added.
  if (described && required.text.length === caret) {
    syntaxTrees.set(ir, described.getSyntaxTree);
  }

  return ir;
};

/** One way to read a command to its end. The positions of the arguments are those in `text`. */
export interface CommandReading {
  text: string;
  arguments: WrittenArgument[];
}

/**
 * The command the cursor is in, read to its end: what is written after the cursor belongs to
 * it too. There are two readings, in this order: the text as it is, and the text with what
 * the cursor is missing filled in (a value, then the brackets still open), which keeps what
 * follows from being pulled into an unfinished expression. The caller takes the first reading
 * that holds what it looks for. Nothing is read when nothing is written after the cursor.
 */
export const readToEndOfCommand = (
  text: string,
  offset: number,
  ir: CursorIR
): CommandReading[] => {
  const [first] = ir.written;
  const before = text.slice(0, offset);
  const after = text.slice(offset);

  if (!first || !after.trim()) {
    return [];
  }

  const isMissingValue = !ir.word && ir.arguments.length > 0 && ir.position !== 'after_argument';
  const value = isMissingValue ? getValuePlaceholder(ir.arguments) : '';
  const closers = openBrackets(before)
    .reverse()
    .map((opener) => CLOSER_OF[opener] ?? '')
    .join('');

  return [text, `${before} ${value}${closers} ${after}`].map((reading) => ({
    text: reading,
    arguments:
      describeCommands(reading).find(({ start }) => start === first.start)?.arguments ?? [],
  }));
};
