/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ICommandMethods } from '../registry/registry';
import type { ICommandContext } from '../registry/types';
import { matchSpec } from './match';
import { offer } from './offer';
import { getTokensBeforeCursor } from './tokens';
import type { CommandSpec } from './types';

/**
 * The autocomplete of a command, from the spec of its syntax: find what the spec allows at
 * the cursor, and offer it.
 */
export const createSpecAutocomplete =
  (spec: CommandSpec): ICommandMethods<ICommandContext>['autocomplete'] =>
  async (query, command, callbacks, _context, cursorPosition = query.length) => {
    const tokens = getTokensBeforeCursor(query.substring(0, cursorPosition), command);
    const { expected } = matchSpec(spec, tokens);
    const items = await Promise.all(expected.map((item) => offer(item, callbacks)));

    return items.flat();
  };
