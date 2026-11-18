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

/** The cursor in the grammar, with what the providers need to know about the editor. */
export interface Located {
  fullText: string;
  offset: number;
  ir: CursorIR;
  /** The cursor is at the value of an option that is read from the tokens. */
  isAtOptionValue: boolean;
  /** Nothing where nothing can be offered. */
  context: SuggestionContext | undefined;
}

/** What is offered at a cursor, with the items that continue the command kept apart. */
export interface Provided {
  /** Everything offered, before it is presented. */
  items: ISuggestionItem[];
  /** The items for what can follow in the command: its keywords, separators and its end. */
  continuations: Array<{ request: SuggestionRequest; items: ISuggestionItem[] }>;
}

export type Collected = Located & Provided;

const NOTHING: Provided = { items: [], continuations: [] };

/** Locates the cursor and gathers the context. Nothing is offered yet. */
export const prepare = async (
  fullText: string,
  offset: number,
  callbacks?: ESQLCallbacks
): Promise<Located> => {
  const located = locate(fullText, offset);
  // An option written before a text in another language is read from the tokens.
  const atValue = atOptionValue(located, fullText, offset);
  const ir = atValue ?? located;
  const applies = !NOTHING_APPLIES.includes(ir.position) && !isQualifierAlone(ir);

  return {
    fullText,
    offset,
    ir,
    isAtOptionValue: atValue !== undefined,
    context: applies ? await createContext(fullText, offset, ir, callbacks) : undefined,
  };
};

const isContinuation = ({ kind }: SuggestionRequest): boolean =>
  kind === 'token' || kind === 'end_of_command';

/**
 * Resolves what has to be offered at a located cursor, drops what the written text rules out
 * and provides the rest. With `continuationsOnly`, only what can follow in the command is
 * provided: the items of expressions and of arguments are not built.
 */
export const provideAll = async (
  { fullText, offset, ir, isAtOptionValue, context }: Located,
  { continuationsOnly = false }: { continuationsOnly?: boolean } = {}
): Promise<Provided> => {
  if (!context) {
    return NOTHING;
  }

  // Inside a string only a value can be offered: no keyword and no command starts there.
  // An expression has strings of its own, as the query of a search function.
  const requests = resolve(ir).filter(
    ({ kind }) => ir.position !== 'inside_string' || kind === 'argument' || kind === 'expression'
  );

  // A command that ends with a text in another language: the text has its own grammar.
  const foreignBody = isAtOptionValue ? undefined : getForeignBody(ir, fullText, offset);
  if (foreignBody) {
    return continuationsOnly
      ? NOTHING
      : { items: await provideSublanguage(foreignBody, context), continuations: [] };
  }

  // An expression says whether the command can go on, also when its items are not wanted.
  const expressions: ExpressionSuggestions[] = await Promise.all(
    requests.flatMap((request) =>
      request.kind === 'expression'
        ? [provideExpression(request, context, { withItems: !continuationsOnly })]
        : []
    )
  );
  const state = await getPruneState(requests, expressions, context);
  const provided = await Promise.all(
    prune(requests, state)
      .filter((request) => !continuationsOnly || isContinuation(request))
      .map(async (request) => ({ request, items: await provide(request, context) }))
  );
  const continuations = provided.filter(({ request }) => isContinuation(request));

  if (continuationsOnly) {
    return { items: [], continuations };
  }

  return {
    items: [
      ...expressions.flatMap((expression) => expression.items),
      ...state.assigned,
      ...provided.flatMap(({ items }) => items),
      ...(await provideExtras(context)),
      ...(await provideStartingQueries(context)),
    ],
    continuations,
  };
};

/**
 * Everything the grammar-driven flow offers at a cursor: locate the cursor, resolve what has
 * to be offered there, drop what the written text rules out, and provide the rest.
 */
export const collect = async (
  fullText: string,
  offset: number,
  callbacks?: ESQLCallbacks
): Promise<Collected> => {
  const located = await prepare(fullText, offset, callbacks);

  return { ...located, ...(await provideAll(located)) };
};
