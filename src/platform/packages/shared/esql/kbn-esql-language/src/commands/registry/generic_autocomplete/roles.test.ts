/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { mockContext } from '../../../__tests__/commands/context_fixtures';
import { getFieldNamesByType, suggest } from '../../../__tests__/commands/autocomplete';
import { locateCursor } from '../../../language/shared/cursor_location/cursor_location';
import { createGenericAutocomplete } from './generic_autocomplete';
import { getSlotLabels } from './roles';

// No command spec: everything comes from the grammar labels and the argument roles.
const zeroConfig = createGenericAutocomplete(() => ({}));

const texts = async (query: string, commandName: string) =>
  (await suggest(query, mockContext, commandName, undefined, zeroConfig))
    .map(({ text }) => text)
    .sort();

const labelsAt = (text: string) => {
  const [slot] = locateCursor(text, text.length).expectedRules;
  return getSlotLabels(slot).map(({ label }) => label);
};

const fieldNames = getFieldNamesByType('any');

describe('grammar roles', () => {
  describe('getSlotLabels', () => {
    it.each([
      ['FROM a | RENAME ', ['oldName', 'newName']],
      ['FROM a | RENAME a AS ', ['newName']],
      ['FROM a | RENAME a = ', ['oldName']],
      ['FROM a | RENAME a AS b, ', ['oldName', 'newName']],
      ['FROM a | RENAME a AS b.', ['newName']],
      ['FROM a | ENRICH pol WITH ', ['newName', 'enrichField']],
      ['FROM a | ENRICH pol WITH x = ', ['enrichField']],
    ])('tells the labels apart by the token before the slot at %j', (text, expected) => {
      expect(labelsAt(text)).toEqual(expected);
    });
  });

  describe('slots from roles', () => {
    it('offers existing columns and a new name where both labels fit', async () => {
      expect(await texts('from a | rename ', 'rename')).toEqual([' = ', ...fieldNames].sort());
    });

    it('offers nothing for a new name typed freely', async () => {
      expect(await texts('from a | rename keywordField AS ', 'rename')).toEqual([]);
    });

    it('offers existing columns for an old name', async () => {
      expect(await texts('from a | rename field = ', 'rename')).toEqual([...fieldNames].sort());
    });

    it('offers a new name with `=` where an assignment follows', async () => {
      expect(await texts('from a | completion ', 'completion')).toEqual([' = ']);
    });

    it('offers enrich policies', async () => {
      expect(await texts('from a | enrich ', 'enrich')).toEqual(['`policy$` ', 'policy ']);
    });
  });

  describe('keywords from roles', () => {
    it('offers AS only after an existing column, since AS makes it the old name', async () => {
      expect(await texts('from a | rename keywordField ', 'rename')).toEqual(['= ', 'AS ']);
      expect(await texts('from a | rename field ', 'rename')).toEqual(['= ']);
    });

    it('keeps the keywords after a clause, which any new name allows', async () => {
      expect(await texts('from a | rename keywordField AS foo ', 'rename')).toEqual([
        '\n',
        ', ',
        '| ',
      ]);
    });

    it('keeps every keyword while one is typed, for the editor to filter', async () => {
      expect(await texts('from a | rename field A', 'rename')).toEqual(['= ', 'AS ']);
    });
  });
});
