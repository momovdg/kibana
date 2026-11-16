/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { PromQLSelector } from '@elastic/esql';
import type { PromQLFunctionParamType } from '../../../commands/definitions/types';
import type { PromqlDetailedPosition } from '../../../commands/definitions/utils/autocomplete/promql/types';
import {
  getPromqlBinaryOperatorParamTypes,
  getPromqlFunctionDefinition,
  getPromqlFunctionParamTypes,
  isPromqlAcrossSeriesFunction,
} from '../../../commands/definitions/utils/promql';
import { getPromqlPart, type PromqlPart } from '../../../esql_js_sim/definitions';
import { locatePromql, type PromqlCursor } from '../../../esql_js_sim/grammar';

/** Where the cursor is in a PromQL query, in the terms its suggestions are chosen by. */
export type PromqlPositionKind =
  /** Right after the operator of a label matcher: its value comes. */
  | 'after_label_operator'
  /** A label name is being typed in a selector. */
  | 'after_label_name'
  /** In the braces of a selector, where a label starts or one is complete. */
  | 'after_label_brace'
  /** After the braces of a selector. */
  | 'after_label_selector'
  /** In the list of labels of a grouping or a matching. */
  | 'inside_grouping'
  /** Where an argument of a function starts. */
  | 'inside_function_args'
  /** After a complete argument of a function. */
  | 'after_complete_arg'
  /** After the name of a metric. */
  | 'after_metric'
  /** Right after a binary operator: its right side comes. */
  | 'after_operator'
  /** After a whole expression at the top of the query. */
  | 'after_query'
  /** Anywhere else in the query. */
  | 'inside_query';

export interface PromqlPosition {
  kind: PromqlPositionKind;
  cursor: PromqlCursor;
  /** The types the function or the operator at the cursor takes there; none when unknown. */
  signatureTypes: PromQLFunctionParamType[];
  /** In a function: another argument can follow the one that is written. */
  canAddArgument: boolean;
  /** A label of a selector or of a list is whole: a separator can follow it. */
  isCompleteLabel: boolean;
  /** The cursor is at a selector: after its metric or its braces. */
  isAtSelector: boolean;
  /** The selector at the cursor has no range yet, and one can be written. */
  canAddRange: boolean;
  /** A grouping can be written here, as after an aggregation. */
  canAddGrouping: boolean;
  /** The name of an aggregation is written and its brackets are still to come. */
  isAfterAggregationName: boolean;
}

const NUMBER = /^[+-]?\.?\d/;
// The kinds of position where the argument of a function is what is being written.
const TYPED_KINDS: readonly PromqlPositionKind[] = [
  'inside_function_args',
  'after_complete_arg',
  'after_metric',
  'after_label_selector',
];
const SELECTOR_END = '}';
const QUOTES = /"/g;
const SEPARATOR = ',';

/**
 * Describes the cursor in a PromQL query from what the PromQL grammar says about it: which
 * part of a query can start there, which tokens can come, and which brackets are open.
 */
export const describePromqlPosition = (text: string, offset: number): PromqlPosition => {
  const cursor = locatePromql(text, offset);
  const { rules, followers, word, canEnd, open, closed, previous } = cursor;
  const parts = new Set(rules.map(getPromqlPart).filter((part): part is PromqlPart => !!part));
  const canFollow = (token: string, rule: string): boolean =>
    followers.some((follower) => follower.text === token && follower.path.at(-1) === rule);
  const call = open.findLast(({ name }) => name !== '' && getPromqlFunctionDefinition(name));
  const isInCall = open.some(({ name }) => name !== '');
  const kind = ((): PromqlPositionKind => {
    if (parts.has('label_value')) {
      return 'after_label_operator';
    }
    // In the open quotes of a label value: the matcher is being written.
    if ((text.slice(0, offset).match(QUOTES) ?? []).length % 2 === 1) {
      return 'after_label_brace';
    }
    if (parts.has('label_name')) {
      return word ? 'after_label_name' : 'after_label_brace';
    }
    // A matcher is written and the braces are still open.
    if (
      !rules.length &&
      (canFollow(SEPARATOR, 'labels') || canFollow(SELECTOR_END, 'seriesMatcher'))
    ) {
      return 'after_label_brace';
    }
    if (parts.has('listed_label')) {
      return 'inside_grouping';
    }
    if (parts.has('range') || parts.has('offset') || parts.has('time')) {
      // A range that is being typed still belongs to its selector.
      return parts.has('range') && word && NUMBER.test(word.text)
        ? 'after_label_selector'
        : 'inside_query';
    }
    if (parts.has('metric_or_function')) {
      if (word) {
        if (NUMBER.test(word.text)) {
          return isInCall ? 'after_complete_arg' : 'after_query';
        }

        return isInCall ? 'after_metric' : 'after_query';
      }

      // The matching of the two sides can only be written right after an operator.
      return canFollow('on', 'modifier') ? 'after_operator' : 'inside_function_args';
    }
    // A whole query, or text the grammar cannot go on with, as a bracket too many.
    if (canEnd || (!rules.length && !followers.length)) {
      return 'after_query';
    }
    if (previous === SELECTOR_END) {
      return 'after_label_selector';
    }
    // After a name: one that takes brackets is a function still to be opened.
    if (canFollow('(', 'function')) {
      return isInCall ? 'after_metric' : 'inside_query';
    }
    // After the brackets of an aggregation a grouping can come, so the query goes on there.
    if (closed !== undefined && isPromqlAcrossSeriesFunction(closed.name)) {
      return 'inside_query';
    }

    return isInCall ? 'after_complete_arg' : 'inside_query';
  })();

  // What the function at the cursor takes as the argument the cursor is in, and after an
  // operator what the operator takes on its right.
  const maxArguments = call
    ? Math.max(
        0,
        ...(getPromqlFunctionDefinition(call.name)?.signatures ?? []).map(
          ({ params }) => params.length
        )
      )
    : 0;
  const argument = call ? Math.min(call.argument, Math.max(0, maxArguments - 1)) : 0;
  const typesOfCall = call ? getPromqlFunctionParamTypes(call.name, argument) : [];
  const signatureTypes =
    kind === 'after_operator' && previous
      ? getPromqlBinaryOperatorParamTypes(previous, 1)
      : TYPED_KINDS.includes(kind)
      ? typesOfCall
      : [];
  const typedName = word && !NUMBER.test(word.text) ? word.text : undefined;
  const aggregation = closed?.name ?? typedName ?? (canFollow('(', 'function') ? previous : '');
  const isAggregation = aggregation ? isPromqlAcrossSeriesFunction(aggregation) : false;

  return {
    kind,
    cursor,
    signatureTypes,
    canAddArgument: call !== undefined && call.argument < maxArguments - 1,
    isCompleteLabel:
      (kind === 'after_label_brace' && !parts.has('label_name')) ||
      (kind === 'inside_grouping' && word !== undefined),
    isAtSelector:
      kind === 'after_metric' ||
      kind === 'after_label_selector' ||
      (typedName !== undefined && !getPromqlFunctionDefinition(typedName)),
    // After the name of a metric no range is written yet. While the name is still being
    // typed, the grammar is asked about the place before it, where no range can come.
    canAddRange: kind === 'after_metric' ? word !== undefined : canFollow('[', 'selector'),
    // After the brackets of an aggregation the grammar says whether a grouping can still come:
    // not when one is written before the brackets.
    canAddGrouping:
      isAggregation &&
      (closed === undefined
        ? typedName !== undefined || canFollow('(', 'function')
        : canFollow('by', 'grouping')),
    isAfterAggregationName: isAggregation && closed === undefined,
  };
};

/**
 * The position in the shape the item builders of the PromQL engine take. They read whether a
 * selector is at the cursor and whether it has a range, never the selector itself, so a
 * stand-in says the two.
 */
export const toDetailedPosition = (position: PromqlPosition): PromqlDetailedPosition => {
  const { kind, signatureTypes, canAddArgument, canAddRange, isAtSelector } = position;
  const selector = isAtSelector
    ? ({ ...(!canAddRange && { duration: {} }) } as unknown as PromQLSelector)
    : undefined;

  return {
    type: kind,
    signatureTypes,
    ...(kind === 'after_complete_arg' && canAddArgument && { canSuggestCommaInFunctionArgs: true }),
    ...(position.isCompleteLabel && { isCompleteLabel: true }),
    ...(selector && { selector }),
    ...(kind === 'after_label_selector' && canAddRange && { canSuggestRangeSelector: true }),
    ...(position.canAddGrouping && { canAddGrouping: true }),
    ...(position.isAfterAggregationName && { isAfterAggregationName: true }),
  };
};
