/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { withAutoSuggest } from '../../../commands/definitions/utils/autocomplete/helpers';
import {
  getDateHistogramCompletionItem,
  getTimeseriesDateHistogramCompletionItem,
} from '../../../commands/registry/complete_items';
import type { ISuggestionItem } from '../../../commands/registry/types';
import type { CallSiteId } from '../../../esql_js_sim/definitions';
import { build } from '../expressions/build';
import { readExpression } from '../expressions/environment';
import { getLambdaState, type LambdaState } from '../expressions/lambdas';
import { offer } from '../expressions/offer';
import { describeExpressionPosition } from '../expressions/position';
import { getStartingValues, getValueSnippet } from '../presentation';
import type { SuggestionContext, SuggestionRequest } from '../types';
import { getCurrentItem, isLoneColumn } from '../written';
import { isAssignmentToken } from './tokens';

/** What the expression at the cursor offers, and whether the command can go on after it. */
export interface ExpressionSuggestions {
  /** The call site of the expression. */
  entry: CallSiteId;
  items: ISuggestionItem[];
  /** Something is written that is not yet a whole expression of the type its role asks for. */
  isUnfinished: boolean;
}

const ARROW = '->';
const PARAMETER_NAMES: readonly string[] = ['x', 'y', 'z'];

/** The items of the head of a lambda: its parameters with the arrow, or the arrow alone. */
const provideLambdaHead = (
  lambda: Exclude<LambdaState, { kind: 'body' }>,
  { usedNames }: SuggestionContext
): ISuggestionItem[] => {
  if (lambda.kind === 'arrow') {
    return [withAutoSuggest({ label: ARROW, text: `${ARROW} `, kind: 'Operator', detail: '' })];
  }

  const free = PARAMETER_NAMES.filter((name) => !usedNames.has(name));
  const names = (free.length >= lambda.count ? free : PARAMETER_NAMES).slice(0, lambda.count);
  const head = names.length === 1 ? names[0] : `(${names.join(', ')})`;

  return [
    withAutoSuggest({
      label: `${head} ${ARROW}`,
      text: `${head} ${ARROW} `,
      kind: 'Variable',
      detail: '',
    }),
  ];
};

/**
 * The expression at the cursor, by the role of the argument it is, in four steps: where the
 * cursor is in it (from the grammar), the types of what is written, what is offered there (a
 * rule, as data), and the items for that.
 */
export const provideExpression = async (
  request: Extract<SuggestionRequest, { kind: 'expression' }>,
  context: SuggestionContext
): Promise<ExpressionSuggestions> => {
  const { role, resolved, entry } = request;
  const { ir, offset, callbacks } = context;
  const lambda = getLambdaState(ir);

  if (lambda && lambda.kind !== 'body') {
    return { entry, items: provideLambdaHead(lambda, context), isUnfinished: true };
  }

  const environment = await readExpression(request, lambda, context);

  if (!environment) {
    return { entry, items: [], isUnfinished: false };
  }

  const position = describeExpressionPosition(ir, entry);
  const offered = offer({
    ...environment,
    ir,
    position,
    offset,
    textBefore: environment.request.query.slice(0, offset),
    preferred: role.types ?? [],
    allowsSubquery: role.subqueries ?? false,
    location: environment.request.location,
  });
  const items = await build(offered, environment.request, ir);
  const startsExpression = position.kind === 'empty' && !position.call;
  // Where a grouping starts, the editor also offers a ready-made date histogram.
  const histogram =
    role.mode === 'grouping' && startsExpression
      ? [
          (context.sourceIsTimeSeries
            ? getTimeseriesDateHistogramCompletionItem
            : getDateHistogramCompletionItem)(
            (await callbacks?.getPreferences?.())?.histogramBarTarget
          ),
        ]
      : [];
  // Where the expression starts and nothing is typed yet, the editor also offers the
  // ready-made values it has for it.
  const starter = resolved.id === undefined ? undefined : getStartingValues()[resolved.id];
  const readyMade =
    startsExpression && !ir.word
      ? [...getValueSnippet(resolved.id), ...(starter ? [starter] : [])]
      : [];
  const hasItsType = !role.completeAs || environment.expressionType === role.completeAs;
  // Where the items are computed values that can be given a name, a column alone is not a
  // finished item: it computes nothing, and it may still be the name.
  const mayStillBeName =
    role.computes === true &&
    ir.followers.some(isAssignmentToken) &&
    isLoneColumn(getCurrentItem(ir.written, entry));

  return {
    entry,
    items: [...items, ...histogram, ...readyMade],
    isUnfinished:
      (environment.isStarted && !(environment.isComplete && hasItsType)) || mayStillBeName,
  };
};
