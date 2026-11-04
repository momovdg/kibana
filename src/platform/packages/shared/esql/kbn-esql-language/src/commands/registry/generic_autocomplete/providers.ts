/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLSingleAstItem } from '@elastic/esql/types';
import { suggestForExpression } from '../../definitions/utils';
import { getNewUserDefinedColumnSuggestion } from '../complete_items';
import {
  buildPoliciesDefinitions,
  getPolicyNameRange,
  modeSuggestions,
  noPoliciesAvailableSuggestion,
} from '../enrich/util';
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import type { GetColumnsByTypeFn, ISuggestionItem } from '../types';
import type { ExpressionSpec, SlotDefinition, SlotProvider, SuggestContext } from './types';

type ColumnsOptions = Parameters<GetColumnsByTypeFn>[2];

/** The existing columns, through `callbacks.getByType`. */
export const columns =
  ({
    ignored,
    options,
  }: {
    ignored?: (ctx: SuggestContext) => string[];
    options?: ColumnsOptions;
  } = {}): SlotProvider =>
  async (ctx) =>
    (await ctx.callbacks?.getByType?.('any', ignored?.(ctx) ?? [], options)) ?? [];

/** A new column name, e.g. `col0 = `. */
export const newName =
  (): SlotProvider =>
  async ({ callbacks }) =>
    [getNewUserDefinedColumnSuggestion(callbacks?.getSuggestedUserDefinedColumnName?.() || '')];

/** Nothing: the user types the value freely. */
export const none = (): SlotProvider => async () => [];

/** Several providers at one slot, e.g. an existing column or a new name. */
export const merged =
  (...providers: SlotProvider[]): SlotProvider =>
  async (ctx, slot) =>
    (await Promise.all(providers.map((provide) => provide(ctx, slot)))).flat();

/**
 * Enrich policy names. A word starting with `_` and no `:` is a mode prefix; after `_mode:`
 * the policy replaces only the text after the colon.
 */
export const policies =
  (): SlotProvider =>
  async ({ context, location }) => {
    const { partial } = location;
    if (partial?.text.startsWith('_') && !partial.text.includes(':')) {
      return modeSuggestions;
    }

    const items = buildPoliciesDefinitions([...(context?.policies?.values() ?? [])]);
    if (!items.length) {
      return [noPoliciesAvailableSuggestion];
    }

    const rangeToReplace = getPolicyNameRange(location);
    return rangeToReplace ? items.map((item) => ({ ...item, rangeToReplace })) : items;
  };

export const DEFAULT_SLOTS: readonly SlotDefinition[] = [
  { rule: 'qualifiedName', provide: columns() },
  { rule: 'qualifiedNamePattern', provide: columns() },
  { rule: 'enrichPolicyName', provide: policies() },
];

/** The last argument starting before the cursor, unless the cursor starts a new one. */
const findExpressionRoot = ({
  command,
  cursorPosition,
  location: { partial, previousTokenType },
}: SuggestContext): ESQLSingleAstItem | undefined => {
  if (!partial && previousTokenType === getTokenType('COMMA')) {
    return undefined;
  }

  for (let index = command.args.length - 1; index >= 0; index--) {
    const arg = command.args[index];
    if (Array.isArray(arg) || arg.type === 'option' || arg.location.min >= cursorPosition) {
      continue;
    }
    if (arg.type !== 'order') {
      return arg;
    }
    const [expression] = arg.args;
    return Array.isArray(expression) ? undefined : expression;
  }
  return undefined;
};

/** One expression-engine call for the expression at the cursor. */
export const suggestExpression = async (
  ctx: SuggestContext,
  { location, options, getRoot = findExpressionRoot }: ExpressionSpec
): Promise<ISuggestionItem[]> => {
  const { query, command, cursorPosition, context, callbacks } = ctx;
  const { suggestions } = await suggestForExpression({
    query,
    expressionRoot: getRoot(ctx),
    command,
    cursorPosition,
    location,
    context,
    callbacks,
    options: typeof options === 'function' ? options(ctx) : options,
  });

  return suggestions;
};
