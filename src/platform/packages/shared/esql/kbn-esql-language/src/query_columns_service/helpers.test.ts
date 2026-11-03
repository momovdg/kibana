/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Parser } from '@elastic/esql';
import type { ESQLFieldWithMetadata } from '@kbn/esql-types';
import type { ESQLPolicy } from '../commands/registry/types';
import { getCurrentQueryAvailableColumns } from './helpers';

describe('getCurrentQueryAvailableColumns', () => {
  describe('after ENRICH', () => {
    const policies = new Map<string, ESQLPolicy>([
      [
        'host_owners',
        {
          name: 'host_owners',
          sourceIndices: ['owners'],
          matchField: 'host',
          enrichFields: ['owner'],
        },
      ],
    ]);
    const hostField: ESQLFieldWithMetadata = { name: 'host', type: 'keyword', userDefined: false };
    const ownerField: ESQLFieldWithMetadata = {
      name: 'owner',
      type: 'keyword',
      userDefined: false,
    };

    it.each(['host_owners', '_any:host_owners'])(
      'adds the enrich fields of %s',
      async (policyName) => {
        const query = `FROM logs | ENRICH ${policyName} ON host WITH owner`;
        const { root } = Parser.parse(query);
        const fetchFields = jest.fn(async () => [ownerField]);

        const columns = await getCurrentQueryAvailableColumns(
          root.commands,
          [hostField],
          fetchFields,
          async () => policies,
          async () => ({ indices: [] }),
          query
        );

        expect(fetchFields).toHaveBeenCalledWith('FROM owners | KEEP owner');
        expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining(['host', 'owner']));
      }
    );
  });
});
