/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { isColumn, isSource } from '@elastic/esql';
import type { ESQLSingleAstItem } from '@elastic/esql/types';
import { suggestForExpression } from '../../definitions/utils';
import { buildFieldsDefinitions } from '../../definitions/utils/functions';
import { getNewUserDefinedColumnSuggestion } from '../complete_items';
import {
  buildMatchingFieldsDefinition,
  buildPoliciesDefinitions,
  getPolicyNameRange,
  modeSuggestions,
  noPoliciesAvailableSuggestion,
} from '../enrich/util';
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import { getLocationInfo } from '../location';
import type { ESQLPolicy, GetColumnsByTypeFn, ISuggestionItem } from '../types';
import type { ExpressionSpec, SlotDefinition, SlotProvider, SuggestContext } from './types';

type ColumnsOptions = Parameters<GetColumnsByTypeFn>[2];

/**
 * The columns that are already whole items of the command's list before the word being typed,
 * e.g. `a` and `b` in `SORT a ASC, b, `; they are not suggested again.
 */
export const listedColumns = ({ command, location, cursorPosition }: SuggestContext): string[] => {
  const end = location.partial?.start ?? cursorPosition;
  const names: string[] = [];
  for (const arg of command.args) {
    const item = !Array.isArray(arg) && arg.type === 'order' ? arg.args[0] : arg;
    if (isColumn(item) && item.location.max < end) {
      names.push(item.parts.join('.'));
    }
  }
  return names;
};

/** The existing columns, through `callbacks.getByType`, without those already listed. */
export const columns =
  ({
    ignored = listedColumns,
    options,
  }: {
    ignored?: (ctx: SuggestContext) => string[];
    options?: ColumnsOptions;
  } = {}): SlotProvider =>
  async (ctx) =>
    (await ctx.callbacks?.getByType?.('any', ignored(ctx), options)) ?? [];

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

/** The enrich policy the command names, looked up without its `_mode:` prefix as validation does. */
export const getEnrichPolicy = ({ command, context }: SuggestContext): ESQLPolicy | undefined => {
  const source = command.args.find((arg) => isSource(arg));
  if (!isSource(source)) {
    return undefined;
  }
  return context?.policies?.get(source.index?.valueUnquoted ?? source.name);
};

/** The enrich fields of the command's policy. */
export const enrichFields = (): SlotProvider => async (ctx) => {
  const policy = getEnrichPolicy(ctx);
  return policy ? buildFieldsDefinitions(policy.enrichFields, false) : [];
};

/** The columns to match on the command's policy's match field. */
export const matchingColumns = (): SlotProvider => async (ctx) => {
  const policy = getEnrichPolicy(ctx);
  if (!policy) {
    return [];
  }
  const names = [...(ctx.context?.columns.values() ?? [])]
    .filter(({ userDefined }) => !userDefined)
    .map(({ name }) => name);
  return buildMatchingFieldsDefinition(policy.matchField, names);
};

export const DEFAULT_SLOTS: readonly SlotDefinition[] = [
  { rule: 'qualifiedName', provide: columns() },
  { rule: 'qualifiedNamePattern', provide: columns() },
  { rule: 'enrichPolicyName', provide: policies() },
];

/**
 * The last argument starting before the cursor, unless the cursor starts a new one: right
 * after a comma, or while a word is typed after one (`SORT a, b` or an unterminated `SORT a, `b`).
 */
const findExpressionRoot = ({
  command,
  cursorPosition,
  location: { previousTokenType },
}: SuggestContext): ESQLSingleAstItem | undefined => {
  if (previousTokenType === getTokenType('COMMA')) {
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

/**
 * The engine's defaults, plus a space and reopened suggestions after an operator's operand. A
 * new list item leaves out the columns already listed; inside a function they stay.
 */
const defaultExpressionOptions = (ctx: SuggestContext) => ({
  addSpaceAfterOperator: true,
  openSuggestions: true,
  ignoredColumnsForEmptyExpression: findExpressionRoot(ctx) ? [] : listedColumns(ctx),
});

/** One expression-engine call for the expression at the cursor. */
export const suggestExpression = async (
  ctx: SuggestContext,
  {
    location,
    options = defaultExpressionOptions,
    getRoot = findExpressionRoot,
  }: ExpressionSpec = {}
): Promise<ISuggestionItem[]> => {
  const { query, command, cursorPosition, context, callbacks } = ctx;
  const { suggestions } = await suggestForExpression({
    query,
    expressionRoot: getRoot(ctx),
    command,
    cursorPosition,
    // Derived from the command and option, as validation does.
    location:
      location ??
      getLocationInfo(cursorPosition, command, Boolean(context?.isTimeseriesSource), false).id,
    context,
    callbacks,
    options: typeof options === 'function' ? options(ctx) : options,
  });

  return suggestions;
};
