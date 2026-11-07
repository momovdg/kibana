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
import { locateCursor } from '../../shared/cursor_location/cursor_location';
import { setup } from './helpers';

const CARET = '^';

describe('autocomplete cursor location', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['stats', 'FROM index | STATS ^', 'STATS '],
    ['inline stats', 'FROM index, (FROM other | INLINE STATS ^', 'INLINE STATS '],
    ['inline stats', 'FROM index | FORK (WHERE a > 1 | SORT b) (INLINE STATS ^', 'INLINE STATS '],
    ['stats', 'FROM index\n| STATS x = ^\n| WHERE b > 1', 'STATS x = '],
  ])('hands %s the location of %j', async (commandName, query, segmentText) => {
    const methods = esqlCommandRegistry.getCommandMethods(commandName);
    if (!methods) {
      throw new Error(`${commandName} is not registered`);
    }
    const spy = jest.spyOn(methods, 'autocomplete');
    const { suggest } = await setup(CARET);

    await suggest(query);

    const offset = query.indexOf(CARET);
    const text = query.replace(CARET, '');
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , context] = spy.mock.calls[0];
    expect(context?.cursorLocation).toEqual(locateCursor(text, offset));
    expect(context?.cursorLocation?.segment.text).toBe(segmentText);
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
