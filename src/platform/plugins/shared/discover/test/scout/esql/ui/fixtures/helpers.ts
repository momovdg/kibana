/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PageObjects, ScoutPage } from '@kbn/scout';
import { expect } from '@kbn/scout/ui';
import type { DiscoverPageObjects } from '../../../common/ui/fixtures';

/**
 * Opens the inspector's Requests view and asserts the listed request names, leaving
 * the panel open. Reopens rather than waiting on the open panel: `getInspectorRequestAdapters`
 * (use_inspector.ts) freezes the set of adapters when the panel opens, and the chart
 * publishes its adapter only once its own search has loaded — so a panel opened too
 * early never picks the visualization entry up, however long it stays open.
 */
export const expectRequestNames = async (
  { inspector, unifiedTabs }: Pick<DiscoverPageObjects, 'inspector' | 'unifiedTabs'>,
  names: string[]
) => {
  await expect
    .poll(async () => {
      if (await inspector.panel.isVisible()) {
        await inspector.close();
      }
      await unifiedTabs.openInspectorForActiveTab();
      await inspector.openInspectorRequestsView();
      return inspector.getRequestNames();
    })
    .toStrictEqual(names);
};

// More rows than any list of suggestions has before the one looked for.
const MAX_SUGGESTION_MOVES = 40;

/**
 * The moves a user makes in the ES|QL editor and its list of suggestions: typing key by key,
 * walking the list with the arrow keys, accepting with Enter.
 */
export const createEditorUser = (
  page: ScoutPage,
  { esqlEditor }: Pick<PageObjects, 'esqlEditor'>
) => {
  const suggestWidget = esqlEditor.getSuggestWidget();
  // The row Enter accepts. Monaco gives it no test subject, so its classes are the only hook.
  const focusedRow = suggestWidget.locator('.monaco-list-row.focused');
  const focusedLabel = focusedRow.locator('.label-name');

  /** Closes the list and empties the editor. */
  const reset = async () => {
    await page.keyboard.press('Escape');
    await esqlEditor.setQuery('');
  };

  /** Replaces the query by typing it, and waits for the list to open. */
  const type = async (query: string) => {
    await esqlEditor.typeQuery(query);
    await expect(suggestWidget).toBeVisible();
  };

  /** Types the query, waits for `label` to be the focused suggestion and accepts it. */
  const typeAndAccept = async (query: string, label: string) => {
    await type(query);
    await expect(focusedRow).toContainText(label);
    await page.keyboard.press('Enter');
  };

  /** Types at the cursor, waits for `label` to be the focused suggestion and accepts it. */
  const typeMoreAndAccept = async (text: string, label: string) => {
    await page.keyboard.type(text);
    await expect(focusedRow).toContainText(label);
    await page.keyboard.press('Enter');
  };

  /** Moves down the open list to the suggestion with exactly this label, and accepts it. */
  const accept = async (label: string) => {
    await expect(suggestWidget).toBeVisible();

    for (let moves = 0; moves < MAX_SUGGESTION_MOVES; moves++) {
      if ((await focusedLabel.innerText()).trim() === label) {
        await page.keyboard.press('Enter');
        return;
      }
      await page.keyboard.press('ArrowDown');
    }

    throw new Error(`No suggestion "${label}" in the first ${MAX_SUGGESTION_MOVES} of the list`);
  };

  return { suggestWidget, focusedRow, reset, type, typeAndAccept, typeMoreAndAccept, accept };
};
