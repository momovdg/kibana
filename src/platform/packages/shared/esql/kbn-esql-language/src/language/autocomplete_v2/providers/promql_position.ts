/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { isPromqlAcrossSeriesFunction } from '../../../commands/definitions/utils/promql';
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
}

const NUMBER = /^[+-]?\.?\d/;
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
  const isInCall = open.some((name) => name !== '');
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
    if (closed !== undefined && isPromqlAcrossSeriesFunction(closed)) {
      return 'inside_query';
    }

    return isInCall ? 'after_complete_arg' : 'inside_query';
  })();

  return { kind, cursor };
};
