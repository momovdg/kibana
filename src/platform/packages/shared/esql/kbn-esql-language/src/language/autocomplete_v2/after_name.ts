/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ExpectedAtCursor, Follower } from '../../esql_js_sim/grammar';

/** What has to follow a name or a value once it is written, read once for every provider. */
export interface AfterName {
  /** The grammar can read the text with the name in it. */
  isValid: boolean;
  /** A separator can follow: the name is an item of a list. */
  separatorFollows: boolean;
  /** The only token that can follow, when there is exactly one. */
  only?: Follower;
  /** Nothing new has to start after the name: every expected argument only goes on. */
  hasOnlyOpenArguments: boolean;
}

/**
 * Describes the cursor as it is right after a name typed at the place of the real cursor
 * (`SuggestionContext.afterName`). The providers decide from it how an item ends: with a
 * space, with nothing, or with the symbol that has to follow.
 */
export const describeAfterName = ({
  position,
  followers,
  arguments: expected,
}: ExpectedAtCursor): AfterName => ({
  isValid: position !== 'invalid',
  separatorFollows: followers.some((follower) => follower.class === 'separator'),
  only: followers.length === 1 ? followers[0] : undefined,
  hasOnlyOpenArguments: expected.every(({ continues }) => continues),
});
