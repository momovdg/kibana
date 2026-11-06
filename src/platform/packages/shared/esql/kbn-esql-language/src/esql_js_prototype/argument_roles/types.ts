/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/** A parameter of a map argument. */
export interface MapParameter {
  /** The data type of the value, e.g. `keyword` or `boolean`. */
  type: string;
  /** The value is a list of `type`, e.g. `["name", "os"]`. */
  list?: boolean;
  /** The values allowed, e.g. USER_AGENT's properties. */
  values?: string[];
  /** The value Elasticsearch uses when the parameter is left out. */
  default?: string;
  /** The value names a thing outside the query, e.g. an inference endpoint. */
  entityType?: 'inference_endpoint';
  /**
   * The parameter applies only while the arguments named `rule.label` take one of the values,
   * e.g. FUSE's `rank_constant` with `{ 'fuseCommand.fuseType': ['rrf'] }`.
   */
  when?: Record<string, string[]>;
}

/**
 * What a command argument is in the language, in the shape of a function parameter's
 * `ParamHint` (`kind`, `entityType`, `allowedValues`, `constraints`). Roles describe the
 * language only: anything validation could check, never how an editor presents it.
 */
export type ArgumentRole =
  /** An existing column, of one of `types` when given, e.g. `keyword` and `text`. */
  | { kind: 'column'; types?: string[]; constraints?: Record<string, string> }
  /** The name of a column the command creates. Any name is valid, including an existing one. */
  | { kind: 'new_column' }
  /** A named thing outside the query, e.g. an enrich policy or an inference endpoint. */
  | {
      kind: 'entity';
      entityType: 'enrich_policy' | 'enrich_field' | 'lookup_index' | 'inference_endpoint';
      constraints?: Record<string, string>;
    }
  /**
   * A literal value. A string's `format` constraint says what it holds, e.g. a GROK pattern
   * (`grok_pattern`). An `identifier` is an unquoted name, one of `allowedValues`, e.g. FUSE's
   * method. `default` is the value Elasticsearch uses when the argument is left out.
   */
  | {
      kind: 'constant';
      valueType: 'integer' | 'double' | 'string' | 'identifier';
      allowedValues?: string[];
      default?: string;
      constraints?: Record<string, string>;
    }
  /** The name of a command option, set as `name = value`, e.g. DISSECT's `APPEND_SEPARATOR`. */
  | { kind: 'option_name'; allowedValues: string[] }
  /** A map of named parameters, `{ "name": value, … }`, e.g. USER_AGENT's `WITH` options. */
  | { kind: 'map'; parameters: Record<string, MapParameter> }
  /**
   * An expression, filled by the expression grammar, of one of `types` when given. A `format`
   * constraint says what a string there holds, e.g. a prompt to an LLM (`llm_prompt`).
   */
  | { kind: 'expression'; types?: string[]; constraints?: Record<string, string> }
  /** An aggregation, as in a function parameter's `{ kind: 'aggregation' }` hint. */
  | { kind: 'aggregation' };
