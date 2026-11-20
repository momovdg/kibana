/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Location } from '../registry/types';

/*
 * The syntax of a command as data: what comes after its name, in order, and what each part
 * means. A command adds one spec; the code that reads specs knows no command.
 */

/** What a slot can be more than one of. */
interface Listable {
  /** One or more of them, separated by commas. Set with `listOf`. */
  list?: boolean;
}

/** A slot that takes a column of the query. */
export interface ColumnSlot extends Listable {
  kind: 'slot';
  role: 'column';
  /** In a list: a column is listed once. */
  unique?: boolean;
}

/** A slot that takes a literal value, as a number. */
export interface ConstantSlot {
  kind: 'slot';
  role: 'constant';
  /** Values the editor proposes, where any value of the kind is valid. */
  suggestedValues?: readonly string[];
}

/**
 * A slot that takes an expression: columns, functions and operators. It goes on to the end
 * of the command, so it is the last thing of a spec. Only a list of them so far.
 */
export interface ExpressionSlot extends Listable {
  kind: 'slot';
  role: 'expression';
  /** Which functions an expression takes here, in the terms of the function definitions. */
  functions: Location;
  /** In a list: a column on its own is listed once. */
  unique?: boolean;
}

/**
 * A place in a command where the user writes something. What a slot takes is its role, and
 * each role has its own options: what the language says about it, and the closed list of what
 * the editor adds there. A new option is a change here, not a condition in the code that
 * reads specs.
 */
export type SlotNode = ColumnSlot | ConstantSlot | ExpressionSlot;

export type SlotRole = SlotNode['role'];

type SlotOf<Role extends SlotRole> = Extract<SlotNode, { role: Role }>;

/** The keywords a spec can have: one that is not listed is a compile error. */
export type Keyword = 'BY';

/** A word of the language, written as it is. */
export interface KeywordNode {
  kind: 'keyword';
  text: Keyword;
}

/** What may be left out. It starts with a keyword, and is there when that keyword is written. */
export interface OptionalNode {
  kind: 'optional';
  nodes: readonly [KeywordNode, ...SpecNode[]];
}

export type SpecNode = SlotNode | KeywordNode | OptionalNode;

/** The syntax of a command after its name. */
export type CommandSpec = readonly SpecNode[];

type OptionsOf<Role extends SlotRole> = Omit<SlotOf<Role>, 'kind' | 'role' | 'list'>;

// A role that has no options takes none: anything passed for it is a mistake. A role with an
// option that has to be given takes its options always.
export type OptionsArgument<Role extends SlotRole> = keyof OptionsOf<Role> extends never
  ? []
  : Partial<OptionsOf<Role>> extends OptionsOf<Role>
  ? [options?: OptionsOf<Role>]
  : [options: OptionsOf<Role>];

/** A slot, by what it takes: the options are the ones of that role. */
export const slot = <Role extends SlotRole>(
  role: Role,
  ...[options]: OptionsArgument<Role>
): SlotOf<Role> =>
  // The role and its own options make the slot of that role.
  ({ kind: 'slot', role, ...options } as SlotOf<Role>);

/** One or more of a slot, separated by commas. */
export const listOf = <Slot extends SlotNode & Listable>(node: Slot): Slot => ({
  ...node,
  list: true,
});

export const keyword = <Text extends Keyword>(text: Text): KeywordNode & { text: Text } => ({
  kind: 'keyword',
  text,
});

/** A part that may be left out: a keyword, and what comes with it. */
export const optional = (...nodes: OptionalNode['nodes']): OptionalNode => ({
  kind: 'optional',
  nodes,
});
