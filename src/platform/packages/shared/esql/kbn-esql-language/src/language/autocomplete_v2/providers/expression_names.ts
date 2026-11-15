/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { resolveRole, type CallSiteId } from '../../../esql_js_sim/definitions';
import type { CommandReading, WrittenArgument } from '../../../esql_js_sim/grammar';
import { ASSIGNMENT, getItems, isLoneColumn, pathOf, unquoted } from '../written';

/** A name a command defines, with where the value it stands for is written. */
export interface DefinedName {
  name: string;
  start: number;
  end: number;
}

const isNewName = (written: WrittenArgument | undefined): boolean =>
  written?.kind === 'rule' && resolveRole(pathOf(written))?.role.kind === 'new_name';

/**
 * The names the items written at a place define, from the first reading of the command that
 * has anything there:
 *
 * - `name = value` defines the name;
 * - a value on its own is named by its text, as `BUCKET(a, 10)`;
 * - a column on its own defines nothing, unless an item before it defined its name: then the
 *   name stands for the column again.
 *
 * The last definition of a name is the one that holds. `text` is the text the positions of
 * the values refer to.
 */
export const getDefinedNames = (
  place: CallSiteId,
  readings: CommandReading[]
): { text: string; names: DefinedName[] } | undefined => {
  for (const { text, arguments: written } of readings) {
    const items = getItems(written, place);
    const names = new Map<string, DefinedName>();

    for (const parts of items) {
      const [first, second, value] = parts;
      const last = parts[parts.length - 1];

      if (isNewName(first) && second?.text === ASSIGNMENT && value) {
        const name = unquoted(first.text);
        names.set(name, { name, start: value.start, end: last.end });
      } else if (isLoneColumn(parts)) {
        const name = unquoted(first.text);

        if (names.has(name)) {
          names.set(name, { name, start: first.start, end: first.end });
        }
      } else {
        const name = text.slice(first.start, last.end);
        names.set(name, { name, start: first.start, end: last.end });
      }
    }

    if (items.length) {
      return { text, names: [...names.values()] };
    }
  }

  return undefined;
};
