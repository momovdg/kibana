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
import { locate, type CursorIR } from '../../esql_js_sim/grammar';
import { createContext } from './context';
import { atOptionValue, getForeignBody } from './option_shell';
import { getPruneState, prune } from './prune';
import { provide } from './providers';
import { isQualifierAlone } from './providers/entities';
import { provideExpression, type ExpressionSuggestions } from './providers/expressions';
import { provideExtras, provideStartingQueries } from './providers/extras';
import { provideSublanguage } from './providers/sublanguage';
import { resolve } from './resolve';
import type { SuggestionContext, SuggestionRequest } from './types';

/** The positions where nothing can be offered. */
export const NOTHING_APPLIES: readonly string[] = ['inside_comment', 'invalid'];

/** What is offered at a cursor, with the items that continue the command kept apart. */
export interface Collected {
  ir: CursorIR;
  context: SuggestionContext | undefined;
  /** Everything offered, before it is presented. */
  items: ISuggestionItem[];
  /** The items for what can follow in the command: its keywords, separators and its end. */
  continuations: Array<{ request: SuggestionRequest; items: ISuggestionItem[] }>;
}

/**
 * Everything the grammar-driven flow offers at a cursor: locate the cursor, resolve what has
 * to be offered, drop what the written text rules out, and provide the rest.
 */
export const collect = async (
  fullText: string,
  offset: number,
  callbacks?: ESQLCallbacks
): Promise<Collected> => {
  const located = locate(fullText, offset);
  // An option written before a text in another language is read from the tokens.
  const atValue = atOptionValue(located, fullText, offset);
  const ir = atValue ?? located;

  if (NOTHING_APPLIES.includes(ir.position) || isQualifierAlone(ir)) {
    return { ir, context: undefined, items: [], continuations: [] };
  }

  // Inside a string only a value can be offered: no keyword and no command starts there.
  // An expression has strings of its own, as the query of a search function.
  const requests = resolve(ir).filter(
    ({ kind }) => ir.position !== 'inside_string' || kind === 'argument' || kind === 'expression'
  );
  const context = await createContext(fullText, offset, ir, callbacks);

  // A command that ends with a text in another language: the text has its own grammar.
  const foreignBody = atValue ? undefined : getForeignBody(ir, fullText, offset);
  if (foreignBody) {
    const items = await provideSublanguage(foreignBody, context);

    return { ir, context, items, continuations: [] };
  }

  const expressions: ExpressionSuggestions[] = await Promise.all(
    requests.flatMap((request) =>
      request.kind === 'expression' ? [provideExpression(request, context)] : []
    )
  );
  const state = await getPruneState(requests, expressions, context);
  const provided = await Promise.all(
    prune(requests, state).map(async (request) => ({
      request,
      items: await provide(request, context),
    }))
  );

  return {
    ir,
    context,
    items: [
      ...expressions.flatMap((expression) => expression.items),
      ...state.assigned,
      ...provided.flatMap(({ items }) => items),
      ...(await provideExtras(context)),
      ...(await provideStartingQueries(context)),
    ],
    continuations: provided.filter(
      ({ request }) => request.kind === 'token' || request.kind === 'end_of_command'
    ),
  };
};
