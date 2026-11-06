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
import { endsStatement, getSlotSites } from './roles';
import { ESQL_STRING_TYPES } from '../../definitions/types';

// No command spec: everything comes from the grammar labels and the argument roles.
const zeroConfig = createGenericAutocomplete(() => ({}));

const texts = async (query: string, commandName: string) =>
  (await suggest(query, mockContext, commandName, undefined, zeroConfig))
    .map(({ text }) => text)
    .sort();

const labelsAt = (text: string) =>
  locateCursor(text, text.length)
    .expectedRules.flatMap(getSlotSites)
    .map(({ label }) => label);

const fieldNames = getFieldNamesByType('any');

describe('grammar roles', () => {
  describe('getSlotSites', () => {
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

  describe('endsStatement', () => {
    const [valueSlot] = locateCursor('SET a = ', 8).expectedRules;
    const [mapKeySlot] = locateCursor('SET a = { ', 10).expectedRules;
    const [columnSlot] = locateCursor('FROM a | KEEP ', 14).expectedRules;

    it("is true where only the statement end follows the value, as SET's", () => {
      expect(endsStatement(valueSlot)).toBe(true);
    });

    it('is false inside the value and in other commands', () => {
      expect(endsStatement(mapKeySlot)).toBe(false);
      expect(endsStatement(columnSlot)).toBe(false);
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
      // The prompt expression is also expected there, so expression items come too.
      expect(await texts('from a | completion ', 'completion')).toContain(' = ');
    });

    it('offers example values for constants by their type', async () => {
      expect(await texts('from a | limit ', 'limit')).toEqual(['10 ', '100 ', '1000 ']);
      expect(await texts('from a | sample ', 'sample')).toEqual(['.001 ', '.01 ', '.1 ']);
    });

    it('offers enrich policies', async () => {
      expect(await texts('from a | enrich ', 'enrich')).toEqual(['`policy$` ', 'policy ']);
    });
  });

  describe('arguments the grammar does not label', () => {
    const stringFields = getFieldNamesByType(ESQL_STRING_TYPES);

    it('offers columns of the role types where the argument is an expression', async () => {
      expect(await texts('from a | dissect ', 'dissect')).toEqual([...stringFields].sort());
      expect(await texts('from a | uri_parts p = ', 'uri_parts')).toEqual([...stringFields].sort());
    });

    it('continues no expression after a column the role covers', async () => {
      expect(await texts('from a | uri_parts p = keywordField ', 'uri_parts')).toEqual([
        '\n',
        '| ',
      ]);
    });

    it('offers a new name with `=` where an assignment follows', async () => {
      expect(await texts('from a | uri_parts ', 'uri_parts')).toEqual([' = ']);
    });

    it('offers no columns while a double-quoted string is typed', async () => {
      expect(await texts('from a | dissect "a', 'dissect')).toEqual([]);
    });

    it('offers example strings by their format', async () => {
      expect(await texts('from a | dissect keywordField ', 'dissect')).toEqual(['"%{firstWord}" ']);
      expect(await texts('from a | grok keywordField ', 'grok')).toEqual(['"%{WORD:firstWord}" ']);
      expect(await texts('from a | grok keywordField "%{WORD:a}", ', 'grok')).toEqual([
        '"%{WORD:nextWord}" ',
      ]);
      expect(
        await texts('from a | dissect keywordField "%{a}" APPEND_SEPARATOR = ', 'dissect')
      ).toEqual(['":" ', '";" ']);
    });

    it('offers option names with their `=`', async () => {
      expect(await texts('from a | dissect keywordField "%{a}" ', 'dissect')).toEqual([
        '\n',
        'APPEND_SEPARATOR = ',
        '| ',
      ]);
    });
  });

  describe('maps of named parameters', () => {
    const withMap = 'from a | user_agent ua = keywordField WITH { ';

    it('offers the parameters not set yet', async () => {
      expect(await texts(withMap, 'user_agent')).toEqual(
        ['"extract_device_type": ', '"properties": [ $0 ]', '"regex_file": "$0"'].sort()
      );
      expect(await texts(`${withMap}"regex_file": "x", `, 'user_agent')).toEqual(
        ['"extract_device_type": ', '"properties": [ $0 ]'].sort()
      );
    });

    it('offers values by the parameter: its default, booleans, a list', async () => {
      expect(await texts(`${withMap}"regex_file": `, 'user_agent')).toEqual(['"_default_"']);
      expect(await texts(`${withMap}"extract_device_type": `, 'user_agent')).toEqual([
        'false',
        'true',
      ]);
      expect(await texts(`${withMap}"properties": `, 'user_agent')).toEqual(['[ $0 ]']);
    });

    it('offers the list values not listed yet', async () => {
      expect(await texts(`${withMap}"properties": [ `, 'user_agent')).toEqual(
        ['"device"', '"name"', '"os"', '"version"'].sort()
      );
      expect(await texts(`${withMap}"properties": ["name", `, 'user_agent')).toEqual(
        ['"device"', '"os"', '"version"'].sort()
      );
    });

    it('takes list values from the output variant the parameter it varies by names', async () => {
      const ipMap = 'from a | ip_location geo = ipField WITH { ';
      const country = await texts(
        `${ipMap}"database_file": "GeoLite2-Country.mmdb", "properties": [ `,
        'ip_location'
      );
      expect(country).toContain('"country_name"');
      expect(country).not.toContain('"location"');
      // Without a database file, the default database's.
      expect(await texts(`${ipMap}"properties": [ `, 'ip_location')).toContain('"location"');
    });

    it('offers a comma after a value, and nothing inside a nested map', async () => {
      expect(await texts(`${withMap}"regex_file": "x" `, 'user_agent')).toEqual([', ']);
      expect(await texts(`${withMap}"a": { `, 'user_agent')).toEqual([]);
    });
  });

  describe('expression arguments', () => {
    it('prefers the role types, with the scalar functions of a command with no location', async () => {
      const items = await texts('from a | user_agent ua = ', 'user_agent');
      expect(items).toEqual(expect.arrayContaining(['CONCAT($0)', 'keywordField']));
    });

    it('reads the expression of an assignment, not the target name', async () => {
      const items = await texts('from a | ip_location geo = ipField ', 'ip_location');
      expect(items).toEqual(expect.arrayContaining(['WITH { $0 }', '| ']));
      expect(items).not.toContain('CONCAT($0)');
    });

    it('offers only keywords while a keyword nothing listed follows is typed', async () => {
      expect(await texts('from a | ip_location geo = ipField WITH', 'ip_location')).toEqual(
        ['\n', 'WITH { $0 }', '| '].sort()
      );
    });
  });

  describe('field lists', () => {
    it("uses the option's location after its end, so no full-text functions in LIMIT's BY", async () => {
      for (const query of ['from a | limit 10 by ', 'from a | limit 10 by integerField,']) {
        const items = await texts(query, 'limit');
        expect(items).toContain('ABS($0)');
        expect(items).not.toContain('MATCH($0)');
      }
    });

    it('offers comma, pipe and new line after a complete column', async () => {
      expect(
        await texts('from a | change_point doubleField by keywordField ', 'change_point')
      ).toEqual(expect.arrayContaining([', ', '| ', '\n']));
    });
  });

  describe('a name that may start an assignment', () => {
    it('reads an existing column as the expression, any other name as a new column', async () => {
      expect(await texts('from a | completion textField ', 'completion')).toEqual(
        ['\n', 'WITH { $0 }', '| '].sort()
      );
      expect(await texts('from a | completion newColumn ', 'completion')).toEqual(['= ']);
      expect(await texts('from a | rerank "q" on newColumn ', 'rerank')).toEqual(['= ']);
    });

    it('offers a new name where a field list item starts, as `col0 = ` in RERANK ON', async () => {
      const items = await texts('from a | rerank "q" on ', 'rerank');
      expect(items).toEqual(expect.arrayContaining([' = ', 'keywordField']));
      expect(items).not.toContain('integerField');
    });

    it('reads a parameter as the expression', async () => {
      expect(await texts('from a | completion ? ', 'completion')).not.toContain('= ');
    });
  });

  describe('expression roles', () => {
    it('offers the example for a formatted expression where the argument starts', async () => {
      const items = await texts('from a | completion ', 'completion');
      expect(items).toEqual(expect.arrayContaining(['"${0:Your prompt to the LLM.}"', ' = ']));
      expect(await texts('from a | completion c = CONCAT(', 'completion')).not.toContain(
        '"${0:Your prompt to the LLM.}"'
      );
    });

    it('keeps functions whose type depends on their arguments, as CASE', async () => {
      expect(await texts('from a | completion ', 'completion')).toContain('CASE($0)');
    });

    it('applies the role types to every item of the argument', async () => {
      const second = await texts('from a | rerank "q" on textField, ', 'rerank');
      expect(second).toContain('keywordField');
      expect(second).not.toContain('integerField');
    });

    it('keeps the function as the root after a comma between its arguments', async () => {
      const items = await texts('from a | completion c = CONCAT("a",', 'completion');
      expect(items).toContain('keywordField');
      expect(items).not.toContain('"${0:Your prompt to the LLM.}"');
    });
  });

  describe('inference endpoints', () => {
    it('offers the endpoints for an inference_id map parameter', async () => {
      expect(await texts('from a | completion "p" WITH { "inference_id": ', 'completion')).toEqual([
        '"inference_1"',
      ]);
    });
  });

  describe('new column names', () => {
    it("offers Kibana's suggested name for a labelled position, with the comma that follows", async () => {
      expect(await texts('from a | change_point doubleField as ', 'change_point')).toEqual([
        'changePointType, ',
      ]);
      expect(await texts('from a | change_point doubleField as t, ', 'change_point')).toEqual([
        'pValue',
      ]);
    });
  });

  describe('keywords from roles', () => {
    it('chooses between readings of the name: AS for an existing column, = otherwise', async () => {
      expect(await texts('from a | rename keywordField ', 'rename')).toEqual(['AS ']);
      expect(await texts('from a | rename field ', 'rename')).toEqual(['= ']);
    });

    it('keeps every keyword when only one reading of the name is possible', async () => {
      expect(await texts('from a | rename x = unknownColumn ', 'rename')).toEqual([
        '\n',
        ', ',
        '| ',
      ]);
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
