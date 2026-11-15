/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { EXPRESSION_PARTS, resolveRole, type CallSiteId } from '../../esql_js_sim/definitions';
import type { WrittenAncestor, WrittenArgument } from '../../esql_js_sim/grammar';

/*
 * The small questions the engine asks about what is written, in one place. They read the
 * Cursor IR (written arguments, places, call sites), never a node of the syntax tree: the
 * predicates of `@elastic/esql` (`isColumn`, `isAssignment`, ...) are about those nodes.
 */

export const ASSIGNMENT = '=';
export const CAST = '::';
export const MAP_OPENER = '{';

/** Whether two places are the same one: the same call site, started at the same offset. */
export const isSamePlace = (first: WrittenAncestor | undefined, second: WrittenAncestor): boolean =>
  first?.id === second.id && first.start === second.start;

/** Whether two commands are nested in the same commands. */
export const isSameNesting = (first: string[], second: string[]): boolean =>
  first.length === second.length && first.every((rule, index) => rule === second[index]);

/** The part of an expression a call site is (a column, a function name, a map key, ...). */
export const partOf = ({ id }: { id: string }): string | undefined => EXPRESSION_PARTS[id]?.part;

/** Whether a written argument is a column of an expression. */
export const isColumnPart = (written: WrittenArgument): boolean => partOf(written) === 'column';

/** The text of a written argument, for comparing with a keyword or an operator. */
export const lowerTextOf = ({ text }: WrittenArgument): string => text.toLowerCase();

/** A name or a string without the quotes around it. */
export const unquoted = (text: string): string => text.replace(/^["`]|["`]$/g, '');

/** The call sites from the command down to a written argument. */
export const pathOf = ({ ancestors, id }: WrittenArgument): string[] => [
  ...ancestors.map((ancestor) => ancestor.id),
  id,
];

/** Whether something is written directly in a place, and not in a place nested in it. */
export const isDirectlyIn = ({ ancestors }: WrittenArgument, place: WrittenAncestor): boolean =>
  isSamePlace(ancestors.at(-1), place);

/** The id of the role a written argument has. */
export const roleIdOf = (written: WrittenArgument): string | undefined =>
  resolveRole(pathOf(written))?.id;

/**
 * What is written at a place, item by item. Where the place is a list, the items are the
 * places right below it; a separator between them is in none.
 */
export const getItems = (written: WrittenArgument[], place: CallSiteId): WrittenArgument[][] => {
  const items = new Map<string, WrittenArgument[]>();

  for (const argument of written) {
    const index = argument.ancestors.findIndex(({ id }) => id === place);
    const item = index < 0 ? undefined : argument.ancestors[index + 1];

    if (item) {
      const key = `${item.id}|${item.start}`;
      items.set(key, [...(items.get(key) ?? []), argument]);
    }
  }

  return [...items.values()];
};

/** Whether an item is one column and nothing else, as `a` and not `a + 1`. */
export const isLoneColumn = (parts: WrittenArgument[]): boolean =>
  parts.length === 1 && isColumnPart(parts[0]);
