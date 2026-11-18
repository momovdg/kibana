/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Writing whole commands from the list of suggestions: sources and their metadata, the
 * clauses of a command in order, the arguments of a function, a branch. Every step accepts a
 * suggestion and checks the exact query it leaves.
 *
 * These are the behaviours of the grammar-driven autocomplete flow.
 */

import { expect } from '@kbn/scout/ui';
import { createEditorUser, spaceTest } from '../fixtures';

const SOURCE = 'FROM logstash-* ';

spaceTest.describe(
  'Discover ES|QL editor autocomplete: commands',
  { tag: '@local-stateful-classic' },
  () => {
    spaceTest.beforeAll(async ({ discoverScoutSpace }) => {
      await discoverScoutSpace.setupDiscoverDefaults();
    });

    spaceTest.beforeEach(async ({ browserAuth, pageObjects }) => {
      await browserAuth.loginAsPrivilegedUser();
      await pageObjects.discover.goto({ queryMode: 'esql' });
      await pageObjects.discover.waitUntilTabIsLoaded();
    });

    spaceTest.afterAll(async ({ discoverScoutSpace }) => {
      await discoverScoutSpace.teardownDiscoverDefaults();
    });

    spaceTest('starts a query from its source', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('a source command replaces its first letters', async () => {
        await user.typeAndAccept('FR', 'FROM');

        await expect.poll(query).toBe('FROM ');
      });

      await spaceTest.step('the sources are offered after it', async () => {
        await user.typeMoreAndAccept('logst', 'logstash');

        await expect.poll(query).toMatch(/^FROM logstash\S*$/);
      });

      await spaceTest.step('METADATA follows the sources, and its fields follow it', async () => {
        await user.reset();
        await user.type(SOURCE);
        await user.accept('METADATA');

        await expect.poll(query).toBe(`${SOURCE}METADATA `);

        await user.typeMoreAndAccept('_ind', '_index');
        await expect.poll(query).toBe(`${SOURCE}METADATA _index`);
      });
    });

    spaceTest('writes the clauses of a command in order', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('a usual limit, then the next command', async () => {
        await user.type(`${SOURCE}| LIMIT `);
        await user.accept('100');

        await expect.poll(query).toBe(`${SOURCE}| LIMIT 100 `);

        await user.accept('|');
        await expect.poll(query).toBe(`${SOURCE}| LIMIT 100 | `);
      });

      await spaceTest.step('a pattern, its option, the assignment and a separator', async () => {
        await user.reset();
        await user.type(`${SOURCE}| DISSECT extension `);
        await user.accept('"%{firstWord}"');

        await expect.poll(query).toBe(`${SOURCE}| DISSECT extension "%{firstWord}" `);

        await user.accept('APPEND_SEPARATOR');
        await expect
          .poll(query)
          .toBe(`${SOURCE}| DISSECT extension "%{firstWord}" APPEND_SEPARATOR = `);

        await user.accept('":"');
        await expect
          .poll(query)
          .toBe(`${SOURCE}| DISSECT extension "%{firstWord}" APPEND_SEPARATOR = ":" `);
      });

      await spaceTest.step('the query built this way runs', async () => {
        await page.keyboard.press('Escape');
        await pageObjects.discover.submitQueryAndWait();
        await expect(esqlEditor.footerErrorButton).toBeHidden();
      });
    });

    spaceTest('writes the arguments of a function', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('a comma after an argument takes the place of the space', async () => {
        await user.type(`${SOURCE}| EVAL x = ROUND(bytes `);
        await user.accept(',');

        // `bytes, ` and never `bytes ,`. The editor closed the bracket when it was typed.
        await expect.poll(query).toBe(`${SOURCE}| EVAL x = ROUND(bytes, )`);

        // The next argument goes between the comma and the bracket.
        await page.keyboard.type('2');
        await expect.poll(query).toBe(`${SOURCE}| EVAL x = ROUND(bytes, 2)`);
      });

      await spaceTest.step('a column goes between the brackets of an aggregation', async () => {
        await user.reset();
        await user.typeAndAccept(`${SOURCE}| STATS AV`, 'AVG');
        await expect.poll(query).toBe(`${SOURCE}| STATS AVG()`);

        await user.typeMoreAndAccept('byt', 'bytes');
        await expect.poll(query).toMatch(/\| STATS AVG\(bytes ?\)$/);
      });
    });

    spaceTest('opens a branch', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('the brackets of a branch come with the cursor inside', async () => {
        await user.type(`${SOURCE}| FORK `);
        await user.accept('New branch');

        await expect.poll(query).toBe(`${SOURCE}| FORK ()`);
      });

      await spaceTest.step('the commands of a branch are offered inside it', async () => {
        await user.typeMoreAndAccept('WH', 'WHERE');

        await expect.poll(query).toBe(`${SOURCE}| FORK (WHERE )`);
      });
    });
  }
);
