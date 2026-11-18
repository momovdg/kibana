/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { operators, withNameSpacing } from '../../../__tests__/scenarios';
import type { ExpectedSuggestion, ScenarioTable } from '../../../__tests__/scenarios';
import { SuggestionCategory } from '../../../language/autocomplete/utils/sorting/types';

const INDEX = '... <index> ...';
const ON = '... ON <condition>';

const CREATE_INDEX_COMMAND = 'esql.lookup_index.create';

const createIndexItem = (
  indexName: string,
  rangeToReplace?: { start: number; end: number }
): ExpectedSuggestion => ({
  ...(rangeToReplace ? { rangeToReplace } : {}),
  text: indexName,
  label: indexName ? `Create lookup index "${indexName}"` : 'Create lookup index',
  category: SuggestionCategory.CUSTOM_ACTION,
  command: {
    arguments: [{ indexName }],
    id: CREATE_INDEX_COMMAND,
    title: 'Click to create',
  },
  detail: 'Click to create',
  filterText: indexName,
  incomplete: true,
  kind: 'Issue',
});

const lookupIndices = [
  { text: 'join_index ', label: 'join_index', detail: 'Lookup' },
  { text: 'join_index_with_alias ', label: 'join_index_with_alias', detail: 'Lookup' },
  { text: 'lookup_index ', label: 'lookup_index', detail: 'Lookup' },
  { text: 'join_index_alias_1 $0', label: 'join_index_alias_1', detail: 'Alias' },
  { text: 'join_index_alias_2 $0', label: 'join_index_alias_2', detail: 'Alias' },
];

// An alias is followed by a space that reopens the suggestions, as an index is.
const spacedLookupIndices = lookupIndices.map((item) => ({
  ...item,
  text: item.text.replace(' $0', ' '),
}));

export const joinScenarios: ScenarioTable = {
  command: 'join',
  scenarios: withNameSpacing(
    [
      {
        group: '<type> JOIN ...',
        name: 'suggests the command with its description and continuation',
        query: 'FROM index | LOOKUP J',
        status: 'replaced',
        expect: {
          exact: [
            {
              label: 'LOOKUP JOIN',
              text: 'LOOKUP JOIN $0',
              detail: 'Join with a "lookup" mode index',
              kind: 'Keyword',
            },
          ],
        },
      },
      {
        group: '<type> JOIN ...',
        name: 'suggests the rest of the name of the command',
        query: 'FROM index | LOOKUP J',
        status: 'new',
        expect: { exact: ['JOIN '] },
      },

      {
        group: INDEX,
        name: 'suggests lookup indices, aliases, and a create index command',
        query: 'FROM index | LEFT JOIN ',
        status: 'replaced',
        expect: { exact: [createIndexItem(''), ...lookupIndices] },
      },
      {
        group: INDEX,
        name: 'suggests lookup indices, aliases with a space, and a create index command',
        query: 'FROM index | LEFT JOIN ',
        status: 'new',
        expect: { exact: [createIndexItem(''), ...spacedLookupIndices] },
      },
      {
        group: INDEX,
        name: 'suggests indices based on a fragment',
        query: 'FROM index | LOOKUP JOIN join_',
        status: 'replaced',
        expect: { exact: [createIndexItem('join_'), ...lookupIndices] },
      },
      {
        group: INDEX,
        name: 'suggests indices based on a fragment, aliases with a space',
        query: 'FROM index | LOOKUP JOIN join_',
        status: 'new',
        expect: { exact: [createIndexItem('join_'), ...spacedLookupIndices] },
      },
      {
        group: INDEX,
        name: 'does not suggest the create index command when the index already exists',
        query: 'FROM index | LEFT JOIN join_index',
        status: 'replaced',
        expect: { exact: [] },
      },
      {
        group: INDEX,
        name: 'suggests what follows an index that exists, with the index',
        query: 'FROM index | LEFT JOIN join_index',
        status: 'new',
        expect: { exact: ['join_index ON '] },
      },
      {
        group: INDEX,
        name: 'does not suggest the create index command when the index already exists as an alias',
        query: 'FROM index | LEFT JOIN join_index_alias_1',
        status: 'replaced',
        expect: { exact: [] },
      },
      {
        group: INDEX,
        name: 'suggests what follows an alias that exists, with the alias',
        query: 'FROM index | LEFT JOIN join_index_alias_1',
        status: 'new',
        expect: { exact: ['join_index_alias_1 ON '] },
      },
      {
        group: INDEX,
        name: 'does not suggest the create index command without the required privileges',
        query: 'FROM index | LEFT JOIN ',
        world: { canCreateLookupIndex: false },
        status: 'replaced',
        expect: { exact: lookupIndices },
      },
      {
        group: INDEX,
        name: 'suggests no create index command without the required privileges, aliases with a space',
        query: 'FROM index | LEFT JOIN ',
        world: { canCreateLookupIndex: false },
        status: 'new',
        expect: { exact: spacedLookupIndices },
      },
      {
        group: INDEX,
        name: 'suggests the create index command with the user input',
        query: 'FROM index | LEFT JOIN new_join_index',
        status: 'replaced',
        expect: {
          exact: [createIndexItem('new_join_index', { start: 23, end: 37 }), ...lookupIndices],
        },
      },
      {
        group: INDEX,
        name: 'suggests the create index command with the user input, aliases with a space',
        query: 'FROM index | LEFT JOIN new_join_index',
        status: 'new',
        expect: { exact: [createIndexItem('new_join_index'), ...spacedLookupIndices] },
      },
      {
        group: INDEX,
        name: 'strips the coordinator prefix from the create index command',
        query: 'FROM index | LOOKUP JOIN _coordinator:new_join_index',
        status: 'replaced',
        expect: { exact: [createIndexItem('new_join_index'), ...lookupIndices] },
      },
      {
        group: INDEX,
        name: 'strips the coordinator prefix from the create index command, aliases with a space',
        query: 'FROM index | LOOKUP JOIN _coordinator:new_join_index',
        status: 'new',
        expect: { exact: [createIndexItem('new_join_index'), ...spacedLookupIndices] },
      },

      {
        group: ON,
        name: 'shows the ON keyword',
        query: 'FROM index | LOOKUP JOIN join_index ',
        expect: { exact: ['ON '] },
      },
      {
        group: ON,
        name: 'suggests fields of both indices and functions after ON',
        query: 'FROM index | LOOKUP JOIN join_index ON ',
        expect: {
          contains: [
            'textField ',
            'keywordField ',
            'booleanField ',
            'joinIndexOnlyField ',
            'STARTS_WITH($0)',
            'CONTAINS($0)',
          ],
        },
      },
      {
        group: ON,
        name: 'suggests fields after comma',
        query: 'FROM index | LOOKUP JOIN join_index ON textField, ',
        expect: { contains: ['keywordField '] },
      },
      {
        group: ON,
        name: 'suggests fields with field prefix',
        query: 'FROM index | LOOKUP JOIN join_index ON keyw',
        expect: { contains: ['keywordField '] },
      },
      {
        group: ON,
        name: 'suggests fields after comparison operator',
        query: 'FROM index | LOOKUP JOIN join_index ON textField == ',
        expect: { contains: ['keywordField', 'joinIndexOnlyField'] },
      },
      {
        group: ON,
        name: 'suggests fields and full-text search functions after AND',
        query: 'FROM index | LOOKUP JOIN join_index ON textField == "value" AND ',
        expect: { contains: ['keywordField', 'joinIndexOnlyField', 'MATCH($0)', 'QSTR("""$0""")'] },
      },
      {
        group: ON,
        name: 'suggests fields after comma in second condition',
        query: 'FROM index | LOOKUP JOIN join_index ON textField == "value", ',
        expect: { contains: ['keywordField ', 'booleanField '] },
      },
      {
        group: ON,
        name: 'suggests logical operators, comma and pipe after IS NULL',
        query: 'FROM index | LOOKUP JOIN join_index ON textField IS NULL ',
        expect: { exact: [...operators('logical'), ', ', '| ', '\n'] },
      },
      {
        group: ON,
        name: 'suggests all boolean operators after field',
        query: 'FROM index | LOOKUP JOIN join_index ON keywordField ',
        status: 'replaced',
        expect: {
          exact: operators('comparison', 'match', 'patternMatch', 'in', 'nullCheck'),
        },
      },
      {
        group: ON,
        name: 'suggests the operators and the end of the condition after any field',
        query: 'FROM index | LOOKUP JOIN join_index ON keywordField ',
        status: 'new',
        expect: {
          exact: [
            ...operators('comparison', 'match', 'patternMatch', 'in', 'nullCheck'),
            ', ',
            '| ',
            '\n',
          ],
        },
      },
      {
        group: ON,
        name: 'suggests logical operators, comma and pipe after complete expression',
        query: 'FROM index | LOOKUP JOIN join_index ON keywordField == "value" ',
        expect: { exact: [...operators('logical'), ', ', '| ', '\n'] },
      },
    ],
    {
      // An operand after an operator ends with a space, as every operand does.
      'FROM index | LOOKUP JOIN join_index ON textField == ': 'spaced',
      'FROM index | LOOKUP JOIN join_index ON textField == "value" AND ': 'spaced',
    }
  ),
};
