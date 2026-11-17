/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLCallbacks } from '@kbn/esql-types';
import type { ISuggestionItem } from '../../commands/registry/types';
import { collect, NOTHING_APPLIES } from './collect';
import { present } from './present';
import { provideControls } from './providers/controls';
import { getLongerKeywordStart, provideFollowUps } from './whole_word';

/**
 * The grammar-driven autocomplete. Four steps: locate the cursor in the grammar, resolve what
 * has to be offered there, provide the items for each request, and present them.
 */
export const suggest = async (
  fullText: string,
  offset: number,
  callbacks?: ESQLCallbacks
): Promise<ISuggestionItem[]> => {
  const collected = await collect(fullText, offset, callbacks);
  const presented = { fullText, offset, ir: collected.ir, context: collected.context };
  // Right after the character that starts a control, only the controls are offered.
  const controls = NOTHING_APPLIES.includes(collected.ir.position)
    ? undefined
    : provideControls(fullText, offset, callbacks);

  if (controls) {
    return present(controls, { ...presented, ir: { ...collected.ir, command: undefined } });
  }

  const keywordStart = getLongerKeywordStart(collected.ir, fullText, offset);

  if (keywordStart !== undefined) {
    const without = `${fullText.slice(0, keywordStart)}${fullText.slice(offset)}`;

    return present((await collect(without, keywordStart, callbacks)).items, presented);
  }

  const followUps = await provideFollowUps(fullText, offset, collected, callbacks);

  // A word that is already whole is offered with what follows it, and not as itself again. A
  // value that is whole has nothing else to offer, also when nothing follows it.
  const isWholeValue =
    followUps !== undefined && followUps.length === 0 && collected.ir.word?.kind !== 'name';

  return present(followUps?.length || isWholeValue ? followUps ?? [] : collected.items, presented);
};
