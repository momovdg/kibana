/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/*
 * The syntax of a command as data: what comes after its name, in order, and what each part
 * means. A command adds one spec; the code that reads specs knows no command.
 */

/** A slot that takes a column of the query. */
export interface ColumnSlot {
  kind: 'slot';
  role: 'column';
}

/** A slot that takes a literal value, as a number. */
export interface ConstantSlot {
  kind: 'slot';
  role: 'constant';
  /** Values the editor proposes, where any value of the kind is valid. */
  suggestedValues?: readonly string[];
}

/**
 * A place in a command where the user writes something. What a slot takes is its role, and
 * each role has its own options: what the language says about it, and the closed list of what
 * the editor adds there. A new option is a change here, not a condition in the code that
 * reads specs.
 */
export type SlotNode = ColumnSlot | ConstantSlot;

export type SlotRole = SlotNode['role'];

type SlotOf<Role extends SlotRole> = Extract<SlotNode, { role: Role }>;

export type SpecNode = SlotNode;

/** The syntax of a command after its name. */
export type CommandSpec = readonly SpecNode[];

type OptionsOf<Role extends SlotRole> = Omit<SlotOf<Role>, 'kind' | 'role'>;

// A role that has no options takes none: anything passed for it is a mistake.
type OptionsArgument<Role extends SlotRole> = keyof OptionsOf<Role> extends never
  ? []
  : [options?: OptionsOf<Role>];

/** A slot, by what it takes: the options are the ones of that role. */
export const slot = <Role extends SlotRole>(
  role: Role,
  ...[options]: OptionsArgument<Role>
): SlotOf<Role> =>
  // The role and its own options make the slot of that role.
  ({ kind: 'slot', role, ...options } as SlotOf<Role>);
