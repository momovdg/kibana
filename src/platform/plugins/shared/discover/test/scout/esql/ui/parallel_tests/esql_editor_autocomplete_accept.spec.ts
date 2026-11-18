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
import { spaceTest } from '../fixtures';

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
      const suggestWidget = esqlEditor.getSuggestWidget();
      // The row Enter accepts. Monaco gives it no test subject, so its class is the only hook.
      const focusedRow = suggestWidget.locator('.monaco-list-row.focused');

      const resetEditor = async () => {
        await page.keyboard.press('Escape');
        await esqlEditor.setQuery('');
      };

      /** Types the query, waits for `label` to be the focused suggestion and accepts it. */
      const typeAndAccept = async (query: string, label: string) => {
        await esqlEditor.typeQuery(query);
        await expect(suggestWidget).toBeVisible();
        await expect(focusedRow).toContainText(label);
        await page.keyboard.press('Enter');
      };

      await spaceTest.step('a command name replaces its first letters', async () => {
        await typeAndAccept(`${SOURCE}| WH`, 'WHERE');

        await expect.poll(() => esqlEditor.getQuery()).toBe(`${SOURCE}| WHERE `);
      });

      await spaceTest.step('the list opens again after a command name', async () => {
        await expect(suggestWidget).toBeVisible();
      });

      await spaceTest.step('a column replaces its first letters', async () => {
        await resetEditor();
        await typeAndAccept(`${SOURCE}| WHERE byt`, 'bytes');

        // The typed letters are gone: the column is written once.
        await expect.poll(() => esqlEditor.getQuery()).toMatch(/\| WHERE bytes ?$/);
      });

      await spaceTest.step('a function leaves the cursor between its brackets', async () => {
        await resetEditor();
        await typeAndAccept(`${SOURCE}| EVAL x = ROUN`, 'ROUND');

        await expect.poll(() => esqlEditor.getQuery()).toContain('| EVAL x = ROUND(');
        expect(await esqlEditor.getQuery()).not.toContain('$0');

        // What is typed next goes inside the brackets.
        await page.keyboard.type('bytes');
        await expect.poll(() => esqlEditor.getQuery()).toContain('ROUND(bytes');
      });
    });
  }
);
