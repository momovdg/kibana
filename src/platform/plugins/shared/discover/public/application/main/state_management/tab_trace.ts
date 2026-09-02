/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/* PoC #274834 diagnostics. Delete with the branch. */

interface TabTraceEvent {
  t: number;
  event: string;
  tabId?: string;
  detail?: Record<string, unknown>;
}

const MAX_EVENTS = 5_000;
const events: TabTraceEvent[] = [];

let getSnapshotImpl: (() => unknown) | undefined;

/**
 * Hot path. Push only -- no formatting, no logging, no stringify.
 */
export const tabTrace = (event: string, tabId?: string, detail?: Record<string, unknown>) => {
  if (events.length >= MAX_EVENTS) {
    return;
  }
  events.push({ t: Math.round(performance.now()), event, tabId, detail });
};

/**
 * Registered once at store creation so the spec can read exact per-tab state
 * at the moment of the hang. This snapshot is the decisive artifact.
 */
export const registerTabTraceSnapshot = (getSnapshot: () => unknown) => {
  getSnapshotImpl = getSnapshot;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__DISCOVER_TAB_TRACE__ = {
    getEvents: () => events,
    getSnapshot: () => getSnapshotImpl?.(),
    reset: () => {
      events.length = 0;
    },
  };
};
