/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { esqlCommandRegistry } from '../../../commands/registry';
import * as cursorLocation from '../../shared/cursor_location/cursor_location';
import { setup } from './helpers';

const CARET = '^';

describe('autocomplete cursor location', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A command's own autocomplete doesn't read the location, so it isn't computed for it: PromQL's
  // query, a long run of tokens, is the locator's slowest case.
  it.each([
    ['promql', 'PROMQL ^'],
    ['promql', 'PROMQL ^\n| WHERE b > 1'],
    ['promql', 'PROMQL index=metrics step=1m (sum by (instance) (^'],
  ])('computes no location for %s at %j', async (commandName, query) => {
    const methods = esqlCommandRegistry.getCommandMethods(commandName);
    if (!methods) {
      throw new Error(`${commandName} is not registered`);
    }
    const autocompleteSpy = jest.spyOn(methods, 'autocomplete');
    const locateSpy = jest.spyOn(cursorLocation, 'locateCursor');
    const { suggest } = await setup(CARET);

    await suggest(query);

    expect(autocompleteSpy).toHaveBeenCalledTimes(1);
    const [, , , context] = autocompleteSpy.mock.calls[0];
    expect(context?.cursorLocation).toBeUndefined();
    expect(locateSpy).not.toHaveBeenCalled();
  });

  // Commands without their own autocomplete read the location suggest() computed.
  it.each([
    ['enrich', 'FROM index | ENRICH ^'],
    ['keep', 'FROM index, (FROM other | KEEP ^'],
    ['limit', 'FROM index | LIMIT ^'],
    ['completion', 'FROM index | COMPLETION ^'],
    ['fuse', 'FROM index | FUSE ^'],
    ['mmr', 'FROM index | MMR ^'],
    ['join', 'FROM index | LOOKUP JOIN ^'],
    ['set', 'SET ^'],
    ['where', 'FROM index | WHERE ^'],
    ['eval', 'FROM index | EVAL ^'],
    ['row', 'ROW ^'],
    ['stats', 'FROM index | STATS ^'],
    ['inline stats', 'FROM index | INLINE STATS ^'],
    ['fork', 'FROM index | FORK ^'],
    ['ts', 'TS ^'],
    ['ts', 'FROM index, (TS ^'],
    ['from', 'FROM ^'],
    ['from', 'FROM index, (FROM ^'],
    ['rename', 'FROM index | FORK (RENAME a AS b) (RENAME ^'],
  ])(
    'computes the location once for %s on the generic autocomplete',
    async (commandName, query) => {
      expect(esqlCommandRegistry.getCommandMethods(commandName)?.autocomplete).toBeUndefined();
      const spy = jest.spyOn(cursorLocation, 'locateCursor');
      const { suggest } = await setup(CARET);

      const suggestions = await suggest(query);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(query.replace(CARET, ''), query.indexOf(CARET));
    }
  );
});
