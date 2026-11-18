/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Suggestions for what exists in the cluster: a lookup index and an enrich policy, created
 * by the test. Every step accepts a suggestion and checks the exact query it leaves.
 *
 * These are the behaviours of the grammar-driven autocomplete flow.
 */

import { expect } from '@kbn/scout/ui';
import { createEditorUser, spaceTest } from '../fixtures';

const SOURCE = 'FROM logstash-* ';

// A space has its own names, so that tests of other spaces do not see them.
const namesFor = (scoutSpaceId: string) => {
  const suffix = scoutSpaceId.replace(/[^a-z0-9]/gi, '_').toLowerCase();

  return {
    lookupIndex: `autocomplete_lookup_${suffix}`,
    enrichSource: `autocomplete_enrich_source_${suffix}`,
    enrichPolicy: `autocomplete_policy_${suffix}`,
  };
};

spaceTest.describe(
  'Discover ES|QL editor autocomplete: what exists in the cluster',
  { tag: '@local-stateful-classic' },
  () => {
    spaceTest.beforeAll(async ({ discoverScoutSpace, esClient, scoutSpace }) => {
      const { lookupIndex, enrichSource, enrichPolicy } = namesFor(scoutSpace.id);

      await discoverScoutSpace.setupDiscoverDefaults();

      await esClient.indices.create({
        index: lookupIndex,
        settings: { mode: 'lookup' },
        mappings: { properties: { extension: { type: 'keyword' }, label: { type: 'keyword' } } },
      });
      await esClient.index({
        index: lookupIndex,
        refresh: 'wait_for',
        document: { extension: 'jpg', label: 'image' },
      });

      await esClient.indices.create({
        index: enrichSource,
        mappings: { properties: { extension: { type: 'keyword' }, kind: { type: 'keyword' } } },
      });
      await esClient.index({
        index: enrichSource,
        refresh: 'wait_for',
        document: { extension: 'jpg', kind: 'image' },
      });
      await esClient.enrich.putPolicy({
        name: enrichPolicy,
        match: { indices: enrichSource, match_field: 'extension', enrich_fields: ['kind'] },
      });
      await esClient.enrich.executePolicy({ name: enrichPolicy });
    });

    spaceTest.beforeEach(async ({ browserAuth, pageObjects }) => {
      // Listing enrich policies and lookup indices needs more than the default editor role.
      await browserAuth.loginAsAdmin();
      await pageObjects.discover.goto({ queryMode: 'esql' });
      await pageObjects.discover.waitUntilTabIsLoaded();
    });

    spaceTest.afterAll(async ({ discoverScoutSpace, esClient, scoutSpace }) => {
      const { lookupIndex, enrichSource, enrichPolicy } = namesFor(scoutSpace.id);

      await esClient.enrich.deletePolicy({ name: enrichPolicy }, { ignore: [404] });
      await esClient.indices.delete({
        index: [lookupIndex, enrichSource],
        ignore_unavailable: true,
      });
      await discoverScoutSpace.teardownDiscoverDefaults();
    });

    spaceTest('joins a lookup index from the list', async ({ page, pageObjects, scoutSpace }) => {
      const { esqlEditor } = pageObjects;
      const { lookupIndex } = namesFor(scoutSpace.id);
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('the lookup index replaces its first letters', async () => {
        // The offer to create an index with the typed name comes first: the index is below it.
        await user.type(`${SOURCE}| LOOKUP JOIN autocomplete_look`);
        await user.accept(lookupIndex);

        await expect.poll(query).toBe(`${SOURCE}| LOOKUP JOIN ${lookupIndex} `);
      });

      await spaceTest.step('ON follows the index, and a column follows ON', async () => {
        await user.accept('ON');
        await expect.poll(query).toBe(`${SOURCE}| LOOKUP JOIN ${lookupIndex} ON `);

        await user.typeMoreAndAccept('exten', 'extension');
        await expect.poll(query).toBe(`${SOURCE}| LOOKUP JOIN ${lookupIndex} ON extension `);
      });

      await spaceTest.step('the join built this way runs', async () => {
        await page.keyboard.press('Escape');
        await pageObjects.discover.submitQueryAndWait();
        await expect(esqlEditor.footerErrorButton).toBeHidden();
      });
    });

    spaceTest('enriches with a policy from the list', async ({ page, pageObjects, scoutSpace }) => {
      const { esqlEditor } = pageObjects;
      const { enrichPolicy } = namesFor(scoutSpace.id);
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('the policy replaces its first letters', async () => {
        await user.typeAndAccept(`${SOURCE}| ENRICH autocomplete_pol`, enrichPolicy);

        await expect.poll(query).toBe(`${SOURCE}| ENRICH ${enrichPolicy} `);
      });

      await spaceTest.step('ON and the column to match on', async () => {
        await user.accept('ON');
        await user.typeMoreAndAccept('exten', 'extension');

        await expect.poll(query).toBe(`${SOURCE}| ENRICH ${enrichPolicy} ON extension `);
      });

      await spaceTest.step('WITH offers the fields the policy adds', async () => {
        await user.accept('WITH');
        await expect.poll(query).toBe(`${SOURCE}| ENRICH ${enrichPolicy} ON extension WITH `);

        await user.typeMoreAndAccept('kin', 'kind');
        await expect.poll(query).toBe(`${SOURCE}| ENRICH ${enrichPolicy} ON extension WITH kind`);
      });

      await spaceTest.step('the enrichment built this way runs', async () => {
        await page.keyboard.press('Escape');
        await pageObjects.discover.submitQueryAndWait();
        await expect(esqlEditor.footerErrorButton).toBeHidden();
      });
    });
  }
);
