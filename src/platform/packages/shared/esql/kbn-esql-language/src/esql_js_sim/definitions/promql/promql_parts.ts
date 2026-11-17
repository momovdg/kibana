/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
/** What a place in a PromQL query is, whatever the query. */
export type PromqlPart =
  /** The name of a metric, or of a function when a bracket follows it. */
  | 'metric_or_function'
  /** The name of a label in a selector, as `job` in `{job="api"}`. */
  | 'label_name'
  /** The value a label is matched with. */
  | 'label_value'
  /** A label in a list: of a grouping (`by`, `without`) or of a matching (`on`, `ignoring`). */
  | 'listed_label'
  /** How far back a selector reads, as `5m` in `[5m]`. */
  | 'range'
  /** How far a selector is shifted in time, after `offset`. */
  | 'offset'
  /** The point in time a selector is read at, after `@`. */
  | 'time'
  /** A number, a string or a time written out. */
  | 'literal';

/**
 * What each place of the PromQL grammar is, by the rule that starts there and the rule it is
 * reached through (`parent>rule`). The grammar of the query is the same wherever a query is
 * written, so its places are described here once.
 */
export const PROMQL_PARTS: Readonly<Record<string, PromqlPart>> = {
  'seriesMatcher>identifier': 'metric_or_function',
  'label>labelName': 'label_name',
  'label>labelValue': 'label_value',
  'labelListItem>labelName': 'listed_label',
  'selector>duration': 'range',
  'expression>duration': 'range',
  // An offset is a time written out, or a duration in brackets when it is computed.
  'offset>timeValue': 'offset',
  'offset>duration': 'offset',
  'at>timeValue': 'time',
  'constant>number': 'literal',
  'constant>string': 'literal',
  'constant>timeValue': 'literal',
};

/** The part a rule the PromQL locator reports is, by the rules it is reached through. */
export const getPromqlPart = ({
  rule,
  path,
}: {
  rule: string;
  path: string[];
}): PromqlPart | undefined => PROMQL_PARTS[`${path[path.length - 1]}>${rule}`];
