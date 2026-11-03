/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { esqlCommandRegistry } from '../../../commands/registry';
import { locateCursor } from '../../shared/cursor_location/cursor_location';
import { setup } from './helpers';

const CARET = '^';

describe('autocomplete cursor location', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['keep', 'FROM index | KEEP ^', 'KEEP '],
    ['enrich', 'FROM index | ENRICH ^', 'ENRICH '],
    ['keep', 'FROM index, (FROM other | KEEP ^', 'KEEP '],
    ['where', 'FROM index | FORK (WHERE a > 1 | SORT b) (WHERE ^', 'WHERE '],
    ['eval', 'FROM index\n| EVAL x = ^\n| WHERE b > 1', 'EVAL x = '],
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
});
