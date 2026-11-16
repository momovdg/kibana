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

interface Span {
  text: string;
  start: number;
  end: number;
}

/** An option written before the body of a command: `name = value`, the value maybe a list. */
export interface WrittenOption {
  name: Span;
  assign: Span;
  /** The items of the value written so far, in order. */
  values: Span[];
  /** The cursor is still at the value: nothing separates the two, or the list goes on. */
  open: boolean;
}

/** The options a command has before a body in another language, up to the cursor. */
export interface OptionShell {
  options: WrittenOption[];
  /** Where the body starts, when something that is no option is written before the cursor. */
  bodyStart?: number;
}

const ASSIGN = '=';
const SEPARATOR = ',';

/**
 * Reads the options written between the name of a command and its body, where the body is
 * in another language and its rule takes any token: the grammar then cannot tell an option
 * from the start of the body at the cursor. An option is one of the given names followed by
 * an assignment; the first thing that is none starts the body.
 */
export const readOptionShell = (
  text: string,
  offset: number,
  commandStart: number,
  names: readonly string[]
): OptionShell => {
  const { tokens: stream } = Parser.create(text.slice(0, offset));
  stream.fill();
  const [, ...tokens] = stream.tokens
    .filter(({ type, channel, start }) => {
      return type !== Token.EOF && channel === Token.DEFAULT_CHANNEL && start >= commandStart;
    })
    .map(({ text: tokenText, start, stop }): Span => ({ text: tokenText, start, end: stop + 1 }));
  const known = names.map((name) => name.toLowerCase());
  const options: WrittenOption[] = [];
  let index = 0;

  while (index < tokens.length) {
    const [name, assign] = [tokens[index], tokens[index + 1]];

    if (!known.includes(name.text.toLowerCase()) || assign?.text !== ASSIGN) {
      return { options, bodyStart: name.start };
    }

    const values: Span[] = [];
    let endsWithSeparator = false;
    index += 2;

    // The value is one item, or several with a separator between them.
    while (index < tokens.length) {
      const item = tokens[index];
      const isFirst = values.length === 0 && !endsWithSeparator;

      if (item.text === SEPARATOR && values.length > 0 && !endsWithSeparator) {
        endsWithSeparator = true;
        index++;
      } else if (isFirst || endsWithSeparator) {
        // What is glued to the item belongs to it, as the unit of `5m` or a dash in a name.
        let end = item.end;
        index++;
        while (
          index < tokens.length &&
          tokens[index].start === end &&
          tokens[index].text !== SEPARATOR
        ) {
          end = tokens[index].end;
          index++;
        }
        values.push({ text: text.slice(item.start, end), start: item.start, end });
        endsWithSeparator = false;
      } else {
        break;
      }
    }

    const last = values.at(-1);
    const isLast = index >= tokens.length;

    options.push({
      name,
      assign,
      values,
      open: isLast && (endsWithSeparator || last === undefined || last.end === offset),
    });
  }

  return { options };
};
