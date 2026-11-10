/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { esqlCommandRegistry } from '.';

/**
 * The commands that still have their own autocomplete code. Every other command is completed
 * by the generic autocomplete, from the grammar and the prototype's roles. PROMQL has its own
 * language. LET arrived with its own autocomplete and moves to the generic one next.
 */
const CUSTOM_AUTOCOMPLETE_COMMANDS: readonly string[] = ['let', 'promql'];

describe('custom autocomplete', () => {
  it('is defined only by the allowlisted commands', () => {
    const commandsWithAutocomplete = esqlCommandRegistry
      .getAllCommands()
      .filter(({ methods }) => methods.autocomplete !== undefined)
      .map(({ name }) => name)
      .sort();

    expect(commandsWithAutocomplete).toEqual(CUSTOM_AUTOCOMPLETE_COMMANDS);
  });
});
