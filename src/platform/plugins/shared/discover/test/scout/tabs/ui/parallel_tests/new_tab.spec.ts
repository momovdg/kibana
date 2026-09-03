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

import { type ScoutPage } from '@kbn/scout';
import { expect } from '@kbn/scout/ui';
import { spaceTest } from '../fixtures';

/* PoC #274834 round 2 — delete with the branch.
 *
 * Round 1 established: no tab clobbering (candidate #2 refuted), no
 * pre-delivery fetch drops (candidate #1 refuted), and eventual consistency of
 * tab fetch state. Remaining gaps this round closes:
 *
 * Run A: the ORIGINAL test verbatim (60s budget). Round 1 diagnosed a modified
 * spec; this ties the findings to the reported failure shape. The afterEach
 * dump records the exact app state at the moment of the original
 * "Test timeout of 60000ms exceeded" (a `finally` would be aborted with the
 * test body — afterEach hooks get their own grace period).
 *
 * Run B: does every backgrounded tab heal once selected, within the original
 * test's 30s per-wait budget? Round 1's probe had a false-negative window
 * (it could read "not loading" before the newly selected tab's
 * reset-to-LOADING landed). This probe first waits for the selection to land
 * in Redux via the tracer snapshot — setTabs is dispatched after any reset —
 * so the subsequent status poll is trustworthy. Tabs are addressed by id, not
 * index.
 */

const MARKER = '###274834';
const ESQL_ASYNC_ENDPOINT = '/internal/search/esql_async';

interface TraceTabSnapshot {
  id: string;
  label: string | undefined;
  fetchStatus: string | null;
  forceFetchOnSelect: boolean | null;
  initializationStatus: string | null;
  hasDataStateContainer: boolean;
}

interface TraceSnapshot {
  selectedTabId: string;
  allIds: string[];
  recentlyClosedTabIds: string[];
  tabs: TraceTabSnapshot[];
}

// Per-test capture, reset in beforeEach and flushed by afterEach so the
// artifact survives a test-timeout abort.
const capture = {
  searchRequests: 0,
  searchResponses: 0,
  consoleErrors: [] as string[],
  pageErrors: [] as string[],
  timings: {} as Record<string, unknown>,
};

const readTrace = (page: ScoutPage) =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).__DISCOVER_TAB_TRACE__;
    return dbg ? { events: dbg.getEvents(), snapshot: dbg.getSnapshot() } : null;
  });

const readSnapshot = (page: ScoutPage): Promise<TraceSnapshot | null> =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).__DISCOVER_TAB_TRACE__;
    return dbg ? dbg.getSnapshot() : null;
  });

const readSelectedTabId = (page: ScoutPage): Promise<string | null> =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).__DISCOVER_TAB_TRACE__;
    return dbg ? dbg.getSnapshot()?.selectedTabId ?? null : null;
  });

const readTabFetchStatus = (page: ScoutPage, tabId: string): Promise<string> =>
  page.evaluate((id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).__DISCOVER_TAB_TRACE__;
    const tab = dbg?.getSnapshot()?.tabs?.find((t: { id: string }) => t.id === id);
    return tab ? String(tab.fetchStatus) : 'missing';
  }, tabId);

const dump = async (page: ScoutPage, label: string, extra: Record<string, unknown> = {}) => {
  // The page can be wedged when this runs after a failure; don't let the dump
  // itself eat the afterEach grace period.
  const trace = await Promise.race([
    readTrace(page).catch((err: unknown) => ({ error: String(err) })),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'trace-dump-timeout' }), 15_000)),
  ]);

  // One line per payload so it survives log interleaving across workers.
  // eslint-disable-next-line no-console
  console.log(`${MARKER} ${label} ${JSON.stringify({ ...capture, ...extra, trace })}`);
};

spaceTest.describe('Discover tabs - opening a new tab', { tag: '@local-stateful-classic' }, () => {
  spaceTest.beforeAll(async ({ discoverScoutSpace }) => {
    await discoverScoutSpace.setupDiscoverDefaults();
  });

  spaceTest.beforeEach(async ({ browserAuth, page, pageObjects }) => {
    await browserAuth.loginAsPrivilegedUser();
    await pageObjects.discover.goto({ queryMode: 'classic' });
    await pageObjects.discover.waitUntilTabIsLoaded();

    // PoC #274834: passive capture, no behavior change.
    capture.searchRequests = 0;
    capture.searchResponses = 0;
    capture.consoleErrors = [];
    capture.pageErrors = [];
    capture.timings = {};
    page.on('console', (msg) => {
      if (msg.type() === 'error') capture.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => capture.pageErrors.push(err.message));
    page.on('request', (req) => {
      if (req.url().includes(ESQL_ASYNC_ENDPOINT)) capture.searchRequests++;
    });
    page.on('response', (res) => {
      if (res.url().includes(ESQL_ASYNC_ENDPOINT)) capture.searchResponses++;
    });
  });

  // PoC #274834: runs even when the test body is aborted by a test timeout.
  spaceTest.afterEach(async ({ page }, testInfo) => {
    await dump(page, 'final', {
      test: testInfo.title.includes('quickly opened') ? 'runA' : 'runB',
      status: testInfo.status,
      durationMs: testInfo.duration,
    });
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

  // PoC #274834 Run A: the ORIGINAL flaky test with unchanged semantics and the
  // default 60s budget. Only passive timing capture added; the afterEach dump
  // provides the artifact.
  // TODO should be removed/modified after empty canvas is implemented #255686
  spaceTest('should be able to complete all quickly opened tabs', async ({ pageObjects }) => {
    const { discover, datePicker, unifiedTabs } = pageObjects;
    const started = Date.now();

    await spaceTest.step(
      'set up an ES|QL query over all indices and a wide time range',
      async () => {
        await discover.writeAndSubmitEsqlQuery('FROM *');
        await discover.waitUntilTabIsLoaded();
        await datePicker.setAbsoluteRange({
          from: 'Jan 10, 2000 @ 00:00:00.000',
          to: 'Dec 10, 2025 @ 00:00:00.000',
        });
        await discover.waitUntilTabIsLoaded();
      }
    );
    capture.timings.setupMs = Date.now() - started;

    await spaceTest.step('open many tabs rapidly, then confirm each one loads', async () => {
      const newTabCount = 7;
      const clickMs: number[] = [];
      capture.timings.clickMs = clickMs;

      // Click without waiting between clicks to reproduce the rapid-open race.
      for (let i = 0; i < newTabCount; i++) {
        const t0 = Date.now();
        await unifiedTabs.clickNewTabButton();
        clickMs.push(Date.now() - t0);
      }
      await discover.waitUntilTabIsLoaded();
      capture.timings.burstDoneMs = Date.now() - started;

      // The initial tab plus every rapidly-opened tab should be present.
      await expect(unifiedTabs.getTabs()).toHaveCount(newTabCount + 1);

      // selectTab asserts each tab becomes active and finishes loading.
      const walkMs: Array<{ tab: number; ms: number }> = [];
      capture.timings.walkMs = walkMs;
      for (let i = newTabCount - 1; i > 0; i--) {
        const t0 = Date.now();
        await unifiedTabs.selectTab(i);
        await discover.waitUntilTabIsLoaded();
        await unifiedTabs.hideTabPreview();
        walkMs.push({ tab: i, ms: Date.now() - t0 });
      }
    });
  });

  // PoC #274834 Run B: every backgrounded tab must heal (reach a terminal fetch
  // status) within 30s of being selected — the original test's per-wait budget.
  spaceTest(
    'heals every backgrounded tab on select (PoC #274834 run B)',
    async ({ page, pageObjects }) => {
      // The burst and 8 probes at up to 30s each need more than the default 60s.
      spaceTest.setTimeout(240_000);

      const { discover, datePicker, unifiedTabs } = pageObjects;

      const NEW_TAB_COUNT = 7;
      // Burst resilience is a precondition here, not the thing under test —
      // run A covers click latency. 30s absorbs the >10s stalls seen in round 1.
      const CLICK_TIMEOUT_MS = 30_000;
      const SELECTION_LANDED_MS = 15_000;
      const HEAL_TIMEOUT_MS = 30_000;

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
        const clickMs: number[] = [];
        capture.timings.clickMs = clickMs;
        for (let i = 0; i < NEW_TAB_COUNT; i++) {
          const t0 = Date.now();
          await page.testSubj
            .locator('unifiedTabs_tabsBar_newTabBtn')
            .click({ timeout: CLICK_TIMEOUT_MS });
          clickMs.push(Date.now() - t0);
        }
      });

      // Snapshot the state the burst itself leaves behind before any settling.
      await page.waitForTimeout(2_000);
      await dump(page, 'post-burst');

      const snapshot = await readSnapshot(page);
      if (!snapshot) {
        throw new Error('PoC #274834: tracer snapshot unavailable — is the app instrumented?');
      }
      // Round-1 sentinels: any regression here reopens candidate #2.
      expect(snapshot.allIds).toHaveLength(NEW_TAB_COUNT + 1);
      expect(snapshot.recentlyClosedTabIds).toStrictEqual([]);

      const results: Array<{
        tab: number;
        id: string;
        selectMs: number;
        healMs: number;
        endStatus: string;
        healed: boolean;
      }> = [];
      const strandedIds: string[] = [];

      await spaceTest.step('probe each tab by id', async () => {
        for (let i = snapshot.allIds.length - 1; i > 0; i--) {
          const tabId = snapshot.allIds[i];
          const t0 = Date.now();
          await page.testSubj
            .locator(`unifiedTabs_selectTabBtn_${tabId}`)
            .click({ timeout: CLICK_TIMEOUT_MS });

          // The selection has landed once Redux reports this tab as current.
          // setTabs is dispatched after any reset-to-LOADING, so a subsequent
          // "not loading" reading cannot be a stale pre-reset value.
          await expect
            .poll(() => readSelectedTabId(page).catch(() => null), {
              timeout: SELECTION_LANDED_MS,
            })
            .toBe(tabId);
          const selectMs = Date.now() - t0;

          let healed = true;
          try {
            await expect
              .poll(() => readTabFetchStatus(page, tabId).catch(() => 'unreadable'), {
                timeout: HEAL_TIMEOUT_MS,
              })
              .toMatch(/^(complete|error)$/);
          } catch {
            healed = false;
            strandedIds.push(tabId);
          }
          const endStatus = await readTabFetchStatus(page, tabId).catch(() => 'unreadable');
          results.push({
            tab: i,
            id: tabId,
            selectMs,
            healMs: Date.now() - t0 - selectMs,
            endStatus,
            healed,
          });
          // Dismiss the hover preview so it cannot intercept the next click.
          await unifiedTabs.hideTabPreview();
        }
      });

      capture.timings.probe = results;
      // eslint-disable-next-line no-console
      console.log(`${MARKER} probe ${JSON.stringify({ results, strandedIds })}`);
      await dump(page, 'post-probe');
      expect(strandedIds).toStrictEqual([]);
    }
  );
});
