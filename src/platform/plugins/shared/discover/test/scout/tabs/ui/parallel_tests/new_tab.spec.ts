/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Opening new Discover tabs in classic and ES|QL modes, per-tab state isolation,
 * and stability when many tabs are opened quickly.
 */

import { expect } from '@kbn/scout/ui';
import { spaceTest } from '../fixtures';

spaceTest.describe('Discover tabs - opening a new tab', { tag: '@local-stateful-classic' }, () => {
  spaceTest.beforeAll(async ({ discoverScoutSpace }) => {
    await discoverScoutSpace.setupDiscoverDefaults();
  });

  spaceTest.beforeEach(async ({ browserAuth, pageObjects }) => {
    await browserAuth.loginAsPrivilegedUser();
    await pageObjects.discover.goto({ queryMode: 'classic' });
    await pageObjects.discover.waitUntilTabIsLoaded();
  });

  spaceTest.afterAll(async ({ discoverScoutSpace }) => {
    await discoverScoutSpace.teardownDiscoverDefaults();
  });

  spaceTest.skip('should create a new tab in classic mode', async ({ pageObjects }) => {
    const { discover, filterBar, queryBar, unifiedTabs } = pageObjects;
    const KQL_QUERY = 'machine.os: "macOS"';

    // tab 0 - created automatically with the default data view

    await spaceTest.step(
      'tab 1: create a new tab, create another data view from search bar, set query and filter',
      async () => {
        await unifiedTabs.createNewTab();
        await discover.waitUntilTabIsLoaded();

        await discover.createDataViewFromSearchBar({ name: 'logsta' });
        await discover.waitUntilTabIsLoaded();

        await filterBar.addFilter({ field: 'extension', operator: 'is', value: 'jpeg' });
        await discover.writeAndSubmitKqlQuery(KQL_QUERY);
        await discover.waitUntilTabIsLoaded();
      }
    );

    await spaceTest.step('tab 2: create another new tab in ES|QL mode', async () => {
      await unifiedTabs.createNewTab();
      await discover.waitUntilTabIsLoaded();
      await discover.selectTextBaseLang();
      await discover.waitUntilTabIsLoaded();
      expect(await discover.getEsqlQueryValue()).toBe('FROM logsta* | SORT @timestamp DESC');
    });

    await spaceTest.step(
      'switching tabs restores each tab data view, query and filters',
      async () => {
        await unifiedTabs.selectTab(0);
        await discover.waitUntilTabIsLoaded();
        expect(await discover.getSelectedDataViewName()).toBe('logstash-*');
        expect(await queryBar.getQuery()).toBe('');
        expect(await filterBar.getFilterCount()).toBe(0);

        await unifiedTabs.selectTab(1);
        await discover.waitUntilTabIsLoaded();
        expect(await discover.getSelectedDataViewName()).toBe('logsta*');
        expect(await queryBar.getQuery()).toBe(KQL_QUERY);
        expect(await filterBar.getFilterCount()).toBe(1);
      }
    );

    await spaceTest.step(
      'a new tab inherits the active data view with an empty query and no filters',
      async () => {
        await unifiedTabs.createNewTab();
        await discover.waitUntilTabIsLoaded();
        expect(await discover.getSelectedDataViewName()).toBe('logsta*');
        expect(await queryBar.getQuery()).toBe('');
        expect(await filterBar.getFilterCount()).toBe(0);
      }
    );
  });

  spaceTest.skip('should create a new tab in ES|QL mode', async ({ pageObjects }) => {
    const { discover, unifiedTabs } = pageObjects;
    const defaultQuery = 'FROM logst* | SORT @timestamp DESC';
    const updatedQuery = 'FROM logst* | LIMIT 1050';

    // tab 0 - created automatically with the default data view

    await spaceTest.step('tab 0: create an ad hoc data view from the search bar', async () => {
      expect(await discover.getCurrentQueryMode()).toBe('classic');
      await discover.createDataViewFromSearchBar({ name: 'logst' });
    });

    await spaceTest.step(
      'tab 1: new ES|QL tab defaults to FROM logst* and accepts an edited query',
      async () => {
        await unifiedTabs.createNewTab();
        await discover.waitUntilTabIsLoaded();
        await discover.selectTextBaseLang();
        await discover.waitUntilTabIsLoaded();
        expect(await discover.getEsqlQueryValue()).toBe(defaultQuery);

        await discover.codeEditor.setCodeEditorValue(updatedQuery);
        await discover.submitQuery();
        await discover.waitUntilTabIsLoaded();
        expect(await discover.getEsqlQueryValue()).toBe(updatedQuery);
      }
    );

    await spaceTest.step('tab 2: another new tab resets to the default FROM logst*', async () => {
      await unifiedTabs.createNewTab();
      await discover.waitUntilTabIsLoaded();
      expect(await discover.getEsqlQueryValue()).toBe(defaultQuery);
    });
  });

  // PoC #274834 -- diagnostic only, not a passing test.
  spaceTest('diagnose stranded tabs (PoC #274834)', async ({ page, pageObjects }) => {
    // Generous on purpose: we want a data-bearing assertion failure, not a
    // harness kill at 60s with no artifact.
    spaceTest.setTimeout(180_000);

    const { discover, datePicker, unifiedTabs } = pageObjects;

    const MARKER = '###274834';
    const NEW_TAB_COUNT = 7;
    const PER_TAB_WAIT_MS = 8_000;
    const ESQL_ASYNC_ENDPOINT = '/internal/search/esql_async';

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // If N tabs produce far fewer searches than expected, fetches died
    // client-side before becoming requests -- candidate #1, provable without
    // reading any app-side trace.
    let searchRequests = 0;
    let searchResponses = 0;
    page.on('request', (req) => {
      if (req.url().includes(ESQL_ASYNC_ENDPOINT)) searchRequests++;
    });
    page.on('response', (res) => {
      if (res.url().includes(ESQL_ASYNC_ENDPOINT)) searchResponses++;
    });

    const dump = async (label: string) => {
      const trace = await page
        .evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dbg = (window as any).__DISCOVER_TAB_TRACE__;
          return dbg ? { events: dbg.getEvents(), snapshot: dbg.getSnapshot() } : null;
        })
        .catch((err) => ({ error: String(err) }));

      // One line per payload so it survives log interleaving across workers.
      // eslint-disable-next-line no-console
      console.log(
        `${MARKER} ${label} ${JSON.stringify({
          searchRequests,
          searchResponses,
          consoleErrors,
          pageErrors,
          trace,
        })}`
      );
    };

    try {
      // Keep the expensive setup. Reproducing the production failure
      // faithfully matters more than test speed here -- the width of the race
      // window is part of what we are measuring.
      await spaceTest.step('set up the expensive ES|QL query', async () => {
        await discover.writeAndSubmitEsqlQuery('FROM *');
        await discover.waitUntilTabIsLoaded();
        await datePicker.setAbsoluteRange({
          from: 'Jan 10, 2000 @ 00:00:00.000',
          to: 'Dec 10, 2025 @ 00:00:00.000',
        });
        await discover.waitUntilTabIsLoaded();
      });

      await spaceTest.step('open tabs rapidly', async () => {
        for (let i = 0; i < NEW_TAB_COUNT; i++) {
          await unifiedTabs.clickNewTabButton();
        }
      });

      // Snapshot before any settling: the state the burst itself leaves behind.
      await page.waitForTimeout(2_000);
      await dump('post-burst');

      // Walk every tab with a SHORT bounded wait, recording per-tab outcome
      // instead of stopping at the first hang -- we want to know how many
      // strand and which, not just that one did.
      const stranded: number[] = [];
      await spaceTest.step('probe each tab', async () => {
        const tabCount = await unifiedTabs.getTabs().count();
        // eslint-disable-next-line no-console
        console.log(
          `${MARKER} tab-count ${JSON.stringify({
            expected: NEW_TAB_COUNT + 1,
            actual: tabCount,
          })}`
        );

        for (let i = tabCount - 1; i > 0; i--) {
          await unifiedTabs.selectTab(i);
          try {
            await expect(
              page.testSubj
                .locator('discoverQueryTotalHits')
                .and(page.locator('[data-fetch-status="loading"]'))
            ).toBeHidden({ timeout: PER_TAB_WAIT_MS });
          } catch {
            stranded.push(i);
          }
          await unifiedTabs.hideTabPreview();
        }
        // eslint-disable-next-line no-console
        console.log(`${MARKER} stranded ${JSON.stringify({ stranded })}`);
      });

      await dump('post-probe');
      expect(stranded).toStrictEqual([]);
    } finally {
      await dump('final');
    }
  });
});
