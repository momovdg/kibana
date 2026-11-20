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

/** What a slot takes. */
export interface ColumnRole {
  kind: 'column';
}

/** A literal value, as a number. */
export interface ConstantRole {
  kind: 'constant';
}

export type SlotRole = ColumnRole | ConstantRole;

/**
 * What the editor adds at a slot beyond what the language says. This list is closed: a new
 * kind of addition is a change here, not a condition in the code that reads specs.
 */
export interface SlotPresentation {
  /** Values worth proposing where any value of the kind is valid. */
  suggestedValues?: readonly string[];
}

/** A place in a command where the user writes something: a name, a value. */
export interface SlotNode extends SlotPresentation {
  kind: 'slot';
  name: string;
  role: SlotRole;
}

export type SpecNode = SlotNode;

/** The syntax of a command after its name. */
export type CommandSpec = readonly SpecNode[];

export const slot = (
  name: string,
  role: SlotRole,
  presentation: SlotPresentation = {}
): SlotNode => ({ kind: 'slot', name, role, ...presentation });
