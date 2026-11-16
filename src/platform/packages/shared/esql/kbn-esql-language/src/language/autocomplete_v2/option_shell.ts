/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { ARGUMENT_ROLES, type SublanguageRole } from '../../esql_js_sim/definitions';
import {
  readOptionShell,
  type CursorIR,
  type OptionShell,
  type WrittenArgument,
  type WrittenOption,
} from '../../esql_js_sim/grammar';

/** The rule of a command, read from one of its places: `rule>called` or `rule.label`. */
const commandOf = (place: string): string => place.split(/[.>]/)[0];

/** The role of the text in another language that the command at the cursor ends with. */
const getSublanguageRole = ({ command }: CursorIR): SublanguageRole | undefined =>
  Object.entries(ARGUMENT_ROLES)
    .filter(([place]) => commandOf(place) === command)
    .map(([, role]) => role)
    .find((role): role is SublanguageRole => role.kind === 'sublanguage');

/**
 * The name of the command at the cursor as the first thing written in it. The parser may
 * read nothing of an unfinished text in another language, so the command is found by where
 * it starts, not by what was read of it.
 */
const commandName = (ir: CursorIR): WrittenArgument[] =>
  (ir.commands.at(-1)?.arguments ?? ir.written).slice(0, 1);

const toWritten = (
  id: string,
  { text, start, end }: { text: string; start: number; end: number },
  kind: WrittenArgument['kind'] = 'rule'
): WrittenArgument => ({ id, kind, text, start, end, index: 0, ancestors: [], complete: true });

/** A text in another language at the end of the command at the cursor, with what is before it. */
export interface ForeignBody {
  role: SublanguageRole;
  shell: OptionShell;
  /** The options that are written, as the arguments the engine reads. */
  written: WrittenArgument[];
}

/**
 * The text in another language the command at the cursor ends with, and the options written
 * before it, read from the tokens. Undefined for a command that has no such text.
 */
export const getForeignBody = (
  ir: CursorIR,
  text: string,
  offset: number
): ForeignBody | undefined => {
  const role = getSublanguageRole(ir);
  const names = role?.options && ARGUMENT_ROLES[role.options.names];

  if (!role?.options || names?.kind !== 'option_name') {
    return undefined;
  }

  const { options } = role;
  const shell = readOptionShell(text, offset, ir.segment.start, Object.keys(names.options));

  return {
    role,
    shell,
    written: [
      ...commandName(ir),
      ...shell.options.flatMap(({ name: optionName, assign, values }) => [
        toWritten(options.names, optionName),
        toWritten(`${commandOf(options.names)}>ASSIGN`, assign, 'token'),
        ...values.map((value) => toWritten(options.values, value)),
      ]),
    ],
  };
};

/**
 * The cursor as it is at the value of an option written before a text in another language.
 * The grammar reads such an option as the start of the text until more is written, so here
 * the options are read from the tokens, with the names the signature lists: what is written
 * becomes the options, and what is expected is the value of the one at the cursor. Undefined
 * where the cursor is not at the value of an option.
 */
export const atOptionValue = (ir: CursorIR, text: string, offset: number): CursorIR | undefined => {
  const options = getSublanguageRole(ir)?.options;
  const names = options && ARGUMENT_ROLES[options.names];

  if (!options || names?.kind !== 'option_name') {
    return undefined;
  }

  const shell = readOptionShell(text, offset, ir.segment.start, Object.keys(names.options));
  const current = shell.options.at(-1);

  if (shell.bodyStart !== undefined || !current?.open) {
    return undefined;
  }

  // The item being typed is the word; the items before it are written.
  const typed = current.values.at(-1);
  const word = typed && typed.end === offset ? typed : undefined;
  const asWritten = ({ name: optionName, assign, values }: WrittenOption): WrittenArgument[] => [
    toWritten(options.names, optionName),
    toWritten(`${commandOf(options.names)}>ASSIGN`, assign, 'token'),
    ...values.filter((value) => value !== word).map((value) => toWritten(options.values, value)),
  ];

  return {
    ...ir,
    position: 'start_of_argument',
    arguments: [
      {
        id: options.values,
        rule: commandOf(options.values),
        path: [options.values],
        command: ir.command,
        continues: false,
      },
    ],
    followers: [],
    onlyFollower: undefined,
    word: word && { text: word.text, start: word.start, kind: 'name', complete: true },
    written: [...commandName(ir), ...shell.options.flatMap(asWritten)],
  };
};
