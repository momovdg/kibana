/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ArgumentRole } from '../../esql_js_sim/definitions';
import type { TOKEN_TEXTS } from '../../esql_js_sim/grammar';

/*
 * The syntax of a command as data: its keywords and slots in order, with what each slot means.
 * One spec per command is all a command adds. The matcher reads it to find where the cursor
 * is; the same slots and roles can be read to validate the command and to say which columns
 * it adds.
 */

/** A word the grammar has: a keyword that is not one is a compile error. */
export type KeywordText = Uppercase<(typeof TOKEN_TEXTS)[keyof typeof TOKEN_TEXTS]>;

export interface KeywordNode {
  kind: 'keyword';
  text: KeywordText;
}

/** A word that acts as a keyword where it is written and is no token of the grammar. */
export interface WordNode {
  kind: 'word';
  text: string;
}

/** One of several forms: the first one the text follows. */
export interface ChoiceNode {
  kind: 'choice';
  alternatives: SpecNode[][];
}

/** One or more pipelines in brackets, one after the other, as the branches of a fork. */
export interface BranchesNode {
  kind: 'branches';
}

/** A symbol between two things, as the comma between two names or the `=` of an assignment. */
export interface SymbolNode {
  kind: 'symbol';
  text: ',' | '=';
}

export interface SlotNode<Name extends string = string> {
  kind: 'slot';
  name: Name;
  role: ArgumentRole;
  /** A list of them, separated by commas, read as one: the role says what each item is. */
  list?: boolean;
  /** The name the editor proposes where the user is free to choose one. */
  suggestedName?: string;
  /** A ready-made string the editor proposes for the value, selected once inserted. */
  placeholder?: string;
  /** The parameter a map is opened with: the one a query usually gives. */
  opensWith?: string;
}

/** What may be left out. It is there when its first keyword, or its assignment, is written. */
export interface OptionalNode {
  kind: 'optional';
  nodes: SpecNode[];
}

/** One or more of the same, separated by commas. */
export interface RepeatNode {
  kind: 'repeat';
  nodes: SpecNode[];
}

export type SpecNode =
  | KeywordNode
  | WordNode
  | SymbolNode
  | SlotNode
  | OptionalNode
  | RepeatNode
  | ChoiceNode
  | BranchesNode;

/** The syntax of a command after its name. */
export type CommandSpec = SpecNode[];

export const keyword = (text: KeywordText): KeywordNode => ({ kind: 'keyword', text });
export const word = (text: string): WordNode => ({ kind: 'word', text });
export const choice = (...alternatives: SpecNode[][]): ChoiceNode => ({
  kind: 'choice',
  alternatives,
});
export const branches = (): BranchesNode => ({ kind: 'branches' });
export const symbol = (text: SymbolNode['text']): SymbolNode => ({ kind: 'symbol', text });
export const slot = <Name extends string>(
  name: Name,
  role: ArgumentRole,
  options: Pick<SlotNode, 'list' | 'suggestedName' | 'placeholder' | 'opensWith'> = {}
): SlotNode<Name> => ({ kind: 'slot', name, role, ...options });
export const optional = (...nodes: SpecNode[]): OptionalNode => ({ kind: 'optional', nodes });
export const repeat = (...nodes: SpecNode[]): RepeatNode => ({ kind: 'repeat', nodes });
