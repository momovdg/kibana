/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Building conditions, names and orderings from the list of suggestions alone. Every step
 * accepts a suggestion and checks the exact query it leaves: the text each item writes, what
 * it replaces, and that the list opens again with what comes next.
 *
 * These are the behaviours of the grammar-driven autocomplete flow.
 */

import { expect } from '@kbn/scout/ui';
import { createEditorUser, spaceTest } from '../fixtures';

const SOURCE = 'FROM logstash-* ';

spaceTest.describe(
  'Discover ES|QL editor autocomplete: expressions',
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

    spaceTest('builds a condition from the list', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('an operator follows a column', async () => {
        await user.type(`${SOURCE}| WHERE bytes `);
        await user.accept('>');

        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes > `);
      });

      await spaceTest.step('a whole condition is joined to the next one', async () => {
        // No suggestion is accepted for the number: the list opens again after the space.
        await page.keyboard.type('10 ');
        await user.accept('AND');

        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes > 10 AND `);
      });

      await spaceTest.step('the next condition starts with a column', async () => {
        await user.typeMoreAndAccept('exten', 'extension');

        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes > 10 AND extension `);
      });

      await spaceTest.step('a null check is written in one go', async () => {
        await user.accept('IS NOT NULL');

        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes > 10 AND extension IS NOT NULL`);
      });

      await spaceTest.step('the query built this way runs', async () => {
        await page.keyboard.press('Escape');
        await pageObjects.discover.submitQueryAndWait();
        await expect(esqlEditor.footerErrorButton).toBeHidden();
      });
    });

    spaceTest('opens a list of values after IN', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('the brackets come with the cursor between them', async () => {
        await user.type(`${SOURCE}| WHERE bytes IN `);
        await user.accept('( ... )');

        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes IN ()`);

        // What is typed next goes inside the brackets.
        await page.keyboard.type('1');
        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes IN (1)`);
      });

      await spaceTest.step('a comma after a space takes the place of the space', async () => {
        await page.keyboard.type(' ');
        await user.accept(',');

        // `1, ` and never `1 ,`: the comma is the one every list has.
        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes IN (1, )`);

        await page.keyboard.type('2');
        await expect.poll(query).toBe(`${SOURCE}| WHERE bytes IN (1, 2)`);
      });
    });

    spaceTest('names what a command computes', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('a new column comes with its assignment', async () => {
        await user.type(`${SOURCE}| EVAL `);
        await user.accept('col0');

        await expect.poll(query).toBe(`${SOURCE}| EVAL col0 = `);
      });

      await spaceTest.step('the value of the new column is offered right away', async () => {
        await user.typeMoreAndAccept('ROUN', 'ROUND');

        await expect.poll(query).toContain('| EVAL col0 = ROUND(');
      });

      await spaceTest.step('RENAME offers AS after the column', async () => {
        await user.reset();
        await user.type(`${SOURCE}| RENAME bytes `);
        await user.accept('AS');

        await expect.poll(query).toBe(`${SOURCE}| RENAME bytes AS `);
      });
    });

    spaceTest('orders and groups from the list', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);
      const query = () => esqlEditor.getQuery();

      await spaceTest.step('a direction is offered on a column that is whole', async () => {
        // No space after the column: the direction is offered on the column itself.
        await user.type(`${SOURCE}| SORT bytes`);
        await user.accept('DESC');

        await expect.poll(query).toBe(`${SOURCE}| SORT bytes DESC`);
      });

      await spaceTest.step(
        'a keyword of two words is written whole from its second word',
        async () => {
          await user.reset();
          await user.typeAndAccept(`${SOURCE}| SORT bytes NULLS F`, 'NULLS FIRST');

          await expect.poll(query).toBe(`${SOURCE}| SORT bytes NULLS FIRST`);
        }
      );

      await spaceTest.step('BY follows an aggregation, and a column follows BY', async () => {
        await user.reset();
        await user.type(`${SOURCE}| STATS COUNT(*) `);
        await user.accept('BY');

        await expect.poll(query).toBe(`${SOURCE}| STATS COUNT(*) BY `);

        await user.typeMoreAndAccept('exten', 'extension');
        await expect.poll(query).toBe(`${SOURCE}| STATS COUNT(*) BY extension `);
      });
    });
  }
);
