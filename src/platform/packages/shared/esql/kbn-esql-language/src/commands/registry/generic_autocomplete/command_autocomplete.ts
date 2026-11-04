/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { esqlCommandRegistry } from '..';
import { createGenericAutocomplete, type CommandAutocomplete } from './generic_autocomplete';

/** The generic autocomplete, reading each command's `autocompleteSpec` from the registry. */
export const genericAutocomplete = createGenericAutocomplete(
  ({ name }) => esqlCommandRegistry.getCommandByName(name)?.autocompleteSpec ?? {}
);

/** A command's own autocomplete, or the generic one; undefined for an unknown command. */
export const getCommandAutocomplete = (name: string): CommandAutocomplete | undefined => {
  const command = esqlCommandRegistry.getCommandByName(name);
  return command && (command.methods.autocomplete ?? genericAutocomplete);
};
