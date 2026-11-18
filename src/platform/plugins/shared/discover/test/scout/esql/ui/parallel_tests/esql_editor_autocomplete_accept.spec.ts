/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * What the query looks like after a suggestion is accepted. Which suggestions are offered is
 * covered by the scenario tables in kbn-esql-language; these tests cover what only a browser
 * shows: the text an item replaces, where the cursor lands, and whether the list opens again.
 *
 * The queries are typed key by key and the suggestion is accepted with Enter, as a user does.
 */

import { expect } from '@kbn/scout/ui';
import { createEditorUser, spaceTest } from '../fixtures';

const SOURCE = 'FROM logstash-* ';

spaceTest.describe(
  'Discover ES|QL editor autocomplete: accepting a suggestion',
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

    spaceTest('replaces the word being typed', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);

      await spaceTest.step('a command name replaces its first letters', async () => {
        await user.typeAndAccept(`${SOURCE}| WH`, 'WHERE');

        await expect.poll(() => esqlEditor.getQuery()).toBe(`${SOURCE}| WHERE `);
      });

      await spaceTest.step('the list opens again after a command name', async () => {
        await expect(user.suggestWidget).toBeVisible();
      });

      await spaceTest.step('a column replaces its first letters', async () => {
        await user.reset();
        await user.typeAndAccept(`${SOURCE}| WHERE byt`, 'bytes');

        // The typed letters are gone: the column is written once.
        await expect.poll(() => esqlEditor.getQuery()).toMatch(/\| WHERE bytes ?$/);
      });

      await spaceTest.step('a function leaves the cursor between its brackets', async () => {
        await user.reset();
        await user.typeAndAccept(`${SOURCE}| EVAL x = ROUN`, 'ROUND');

        await expect.poll(() => esqlEditor.getQuery()).toContain('| EVAL x = ROUND(');
        expect(await esqlEditor.getQuery()).not.toContain('$0');

        // What is typed next goes inside the brackets.
        await page.keyboard.type('bytes');
        await expect.poll(() => esqlEditor.getQuery()).toContain('ROUND(bytes');
      });
    });

    spaceTest('continues a command from the list', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);

      await spaceTest.step('the next column of a list replaces its first letters', async () => {
        await user.typeAndAccept(`${SOURCE}| KEEP bytes, exten`, 'extension');

        await expect.poll(() => esqlEditor.getQuery()).toMatch(/\| KEEP bytes, extension/);
      });

      await spaceTest.step(
        'accepting on a column that is already whole does not double it',
        async () => {
          await user.reset();
          await user.type(`${SOURCE}| KEEP bytes`);
          await page.keyboard.press('Enter');

          const query = await esqlEditor.getQuery();
          expect(query).toMatch(/\| KEEP bytes\b/);
          expect(query.match(/bytes/g)).toHaveLength(1);
        }
      );

      await spaceTest.step(
        'a pipe starts the next command, and its names are offered',
        async () => {
          await user.reset();
          await user.type(`${SOURCE}| KEEP bytes `);
          await user.accept('|');

          await expect.poll(() => esqlEditor.getQuery()).toMatch(/\| KEEP bytes \| $/);
          await expect(user.suggestWidget).toBeVisible();
        }
      );

      await spaceTest.step('a query finished from the list runs', async () => {
        await page.keyboard.type('LIM');
        await expect(user.focusedRow).toContainText('LIMIT');
        await page.keyboard.press('Enter');
        // One of the usual limits is focused: any of them will do.
        await expect(user.suggestWidget).toBeVisible();
        await page.keyboard.press('Enter');

        await expect.poll(() => esqlEditor.getQuery()).toMatch(/\| KEEP bytes \| LIMIT \d+ ?$/);

        await page.keyboard.press('Escape');
        // Discover runs the query from its own button: the editor has none of its own here.
        await pageObjects.discover.submitQueryAndWait();
        await expect(esqlEditor.footerErrorButton).toBeHidden();
      });
    });

    // The current flow writes `bytes ,` here: this is one of the behaviours the grammar-driven
    // flow changes on purpose, so this test passes on that flow only.
    spaceTest('writes a comma right after the item it follows', async ({ page, pageObjects }) => {
      const { esqlEditor } = pageObjects;
      const user = createEditorUser(page, pageObjects);

      await spaceTest.step('a comma after a space takes the place of the space', async () => {
        await user.type(`${SOURCE}| KEEP bytes `);
        await user.accept(',');

        await expect.poll(() => esqlEditor.getQuery()).toBe(`${SOURCE}| KEEP bytes, `);
      });

      await spaceTest.step('the next column of the list is offered after the comma', async () => {
        await expect(user.suggestWidget).toBeVisible();
        await page.keyboard.type('exten');
        await expect(user.focusedRow).toContainText('extension');
        await page.keyboard.press('Enter');

        await expect.poll(() => esqlEditor.getQuery()).toMatch(/\| KEEP bytes, extension/);
      });
    });
  }
);
