/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { columns, withNameSpacing } from '../../../__tests__/scenarios';
import type { Scenario, ScenarioTable, ScenarioWorld } from '../../../__tests__/scenarios';

const rows = (
  group: string,
  name: string,
  queries: string[],
  exact: string[],
  world?: Partial<ScenarioWorld>
): Scenario[] => queries.map((query) => ({ group, name, query, world, expect: { exact } }));

const withStatus = (status: Scenario['status'], scenarios: Scenario[]): Scenario[] =>
  scenarios.map((scenario) => ({ ...scenario, status }));

const FIELD_LIST = 'field list';
const TARGET = 'target = field form';
const SUFFIX = 'suffix = "..." ON form';
const WITH_CLAUSE = 'WITH clause';

const SUFFIX_MODIFIER = 'suffix = "${1:_dense_vector}" ON $0';
const WITH = 'WITH { $0 }';
const END_OF_COMMAND = ['\n', '| '];

const stringColumns = columns({ types: ['keyword', 'text'], followedBySpace: true });
// In a list of fields a name comes without a space: the separator usually follows.
const bareStringColumns = columns({ types: ['keyword', 'text'] });

const embeddingEndpoints: Partial<ScenarioWorld> = {
  inferenceEndpoints: [
    { inference_id: 'embed_1', task_type: 'text_embedding' },
    { inference_id: 'inference_1', task_type: 'completion' },
  ],
};

export const denseVectorScenarios: ScenarioTable = {
  command: 'dense_vector',
  // Where the new flow ends a name differently from the current flow.
  scenarios: withNameSpacing(
    [
      ...withStatus(
        'replaced',
        rows(
          FIELD_LIST,
          'suggests the suffix modifier, a target column name, and text and keyword fields',
          ['from a | dense_vector '],
          [SUFFIX_MODIFIER, 'col0 = ', ...stringColumns]
        )
      ),
      ...withStatus('new', [
        // The suffix is named first; its value comes with the next suggestions.
        ...rows(
          FIELD_LIST,
          'suggests the suffix name, a target column name, and text and keyword fields',
          ['from a | dense_vector ', 'from a | dense_vector vec'],
          ['suffix = ', 'col0 = ', ...bareStringColumns]
        ),
      ]),
      ...withStatus(
        'replaced',
        rows(
          FIELD_LIST,
          'suggests the assignment operator after an unrecognized first name',
          ['from a | dense_vector vec'],
          ['= ', 'col0 = ', ...stringColumns]
        )
      ),
      ...rows(
        FIELD_LIST,
        'suggests more fields, but no target assignment or suffix, after a comma',
        ['from a | dense_vector textField, '],
        stringColumns
      ),
      ...withStatus(
        'replaced',
        rows(
          FIELD_LIST,
          'suggests continuations after a complete field',
          ['from a | dense_vector keywordField'],
          [WITH, ', ', ...END_OF_COMMAND, 'col0 = ', ...stringColumns]
        )
      ),
      ...withStatus('new', [
        ...rows(
          FIELD_LIST,
          'suggests what follows a complete field, with the field',
          ['from a | dense_vector keywordField'],
          ['\n', 'keywordField, ', `keywordField ${WITH}`, 'keywordField | ']
        ),
      ]),

      ...rows(
        TARGET,
        'suggests fields, but no further target, inside the assignment',
        ['from a | dense_vector vec = '],
        stringColumns
      ),
      ...withStatus(
        'replaced',
        rows(
          TARGET,
          'suggests continuations, but no comma, after the assigned field',
          ['from a | dense_vector vec = textField '],
          [WITH, ...END_OF_COMMAND]
        )
      ),
      ...withStatus('new', [
        // The grammar takes a list of fields after a named target too.
        ...rows(
          TARGET,
          'suggests continuations and a comma after the assigned field',
          ['from a | dense_vector vec = textField ', 'from a | dense_vector `my,vec` = textField '],
          [WITH, ', ', ...END_OF_COMMAND]
        ),
      ]),
      ...withStatus(
        'replaced',
        rows(
          TARGET,
          'keeps the comma out while the assigned field is still being typed',
          ['from a | dense_vector vec = textField'],
          [WITH, ...END_OF_COMMAND, ...stringColumns]
        )
      ),
      ...withStatus('new', [
        ...rows(
          TARGET,
          'suggests what follows the assigned field, with the field',
          ['from a | dense_vector vec = textField'],
          ['\n', 'textField, ', `textField ${WITH}`, 'textField | ']
        ),
      ]),
      ...withStatus(
        'replaced',
        rows(
          TARGET,
          'offers only pipe and newline after a manually typed comma following a named target',
          ['from a | dense_vector vec = textField, '],
          END_OF_COMMAND
        )
      ),
      ...withStatus('new', [
        {
          group: TARGET,
          name: 'suggests more fields after a comma following a named target',
          query: 'from a | dense_vector vec = textField, ',
          expect: { containsLabels: ['keywordField'], excludes: ['| ', '\n', WITH] },
        },
      ]),
      ...withStatus(
        'replaced',
        rows(
          TARGET,
          'still offers WITH after a target whose quoted name contains a comma',
          ['from a | dense_vector `my,vec` = textField '],
          [WITH, ...END_OF_COMMAND]
        )
      ),

      ...withStatus(
        'replaced',
        rows(
          SUFFIX,
          'suggests only ON while the suffix clause awaits it',
          [
            'from a | dense_vector suffix = "_dense_vector"',
            'from a | dense_vector suffix = "_dense_vector" ',
            'from a | dense_vector SUFFIX = "_dv" ',
            'from a | dense_vector suffix = "_dv" O',
          ],
          ['ON ']
        )
      ),
      ...withStatus('new', [
        // `suffix = "x"` reads two ways in the grammar: the suffix of the new columns, which
        // `ON` and the fields follow, or a column named `suffix` for a text given in the place
        // of the fields, which is complete. Both are offered.
        ...rows(
          SUFFIX,
          'suggests ON, fields, WITH and the end of the command after the value',
          [
            'from a | dense_vector suffix = "_dense_vector" ',
            'from a | dense_vector SUFFIX = "_dv" ',
            'from a | dense_vector suffix = "_dv" O',
          ],
          ['ON', WITH, ...END_OF_COMMAND, ...bareStringColumns]
        ),
        ...rows(
          SUFFIX,
          'suggests what follows the value right after its closing quote, with the value',
          ['from a | dense_vector suffix = "_dense_vector"'],
          ['"_dense_vector" ON', `"_dense_vector" ${WITH}`, '"_dense_vector" | ', '\n']
        ),
      ]),
      ...rows(
        SUFFIX,
        'suggests text and keyword fields, but no target assignment, after ON',
        ['from a | dense_vector suffix = "_dv" ON '],
        stringColumns
      ),
      ...rows(
        SUFFIX,
        'suggests continuations after a field in the ON list',
        ['from a | dense_vector suffix = "_dv" ON textField '],
        [...END_OF_COMMAND, ', ', WITH]
      ),

      ...rows(
        WITH_CLAUSE,
        'suggests the map opener once WITH is typed',
        ['from a | dense_vector textField WITH '],
        ['{ "inference_id": "$0" }']
      ),
      ...rows(
        WITH_CLAUSE,
        'suggests parameter keys inside an empty map',
        ['from a | dense_vector textField WITH { '],
        ['"inference_id": "$0"', '"type": "$0"', '"timeout": "$0"']
      ),
      ...rows(
        WITH_CLAUSE,
        'does not suggest an already-used parameter key after a comma',
        ['from a | dense_vector textField WITH { "inference_id": "inference_1", '],
        ['"type": "$0"', '"timeout": "$0"']
      ),
      ...rows(
        WITH_CLAUSE,
        'suggests the text embedding inference endpoints as inference_id values',
        ['from a | dense_vector textField WITH { "inference_id": "'],
        ['"embed_1"'],
        embeddingEndpoints
      ),
      ...rows(
        WITH_CLAUSE,
        'suggests no endpoint of another task type',
        ['from a | dense_vector textField WITH { "inference_id": "'],
        []
      ),
      ...rows(
        WITH_CLAUSE,
        'suggests text and image as type values',
        ['from a | dense_vector textField WITH { "type": "'],
        ['"text"', '"image"']
      ),
      ...rows(
        WITH_CLAUSE,
        'suggests a default duration as the timeout value',
        ['from a | dense_vector textField WITH { "timeout": "'],
        ['"30s"']
      ),
      ...rows(
        WITH_CLAUSE,
        'does not suggest values for an unsupported parameter',
        ['from a | dense_vector textField WITH { "unsupported_param": "'],
        []
      ),
      ...rows(
        WITH_CLAUSE,
        'suggests only pipe and newline after a complete map',
        ['from a | dense_vector textField WITH { "inference_id": "inference_1" } '],
        END_OF_COMMAND
      ),
    ],
    {
      'from a | dense_vector textField, ': 'bare',
      'from a | dense_vector vec = ': 'bare',
      'from a | dense_vector suffix = "_dv" ON ': 'bare',
    }
  ),
};
