/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ArgumentRole } from './types';

/** The string column types, which DISSECT, GROK and the URI and domain commands read. */
const STRING_TYPES = ['keyword', 'text'];

/** The `WITH` parameters of the commands that call an inference endpoint. */
const INFERENCE_PARAMETERS = {
  inference_id: { type: 'keyword', entityType: 'inference_endpoint' as const },
};

/** The numeric column types, which CHANGE_POINT's value takes. */
const NUMBER_TYPES = [
  'integer',
  'counter_integer',
  'double',
  'unsigned_long',
  'long',
  'counter_long',
  'counter_double',
];

/**
 * The role of each labelled command argument, keyed by `rule.label` from the grammar labels.
 * Hand-maintained; upstream this would live next to the command definitions.
 */
export const ARGUMENT_ROLES: Readonly<Record<string, ArgumentRole>> = {
  'renameClause.oldName': { kind: 'column' },
  'renameClause.newName': { kind: 'new_column' },

  'enrichCommand.policyName': { kind: 'entity', entityType: 'enrich_policy' },
  'enrichCommand.matchField': {
    kind: 'column',
    constraints: { matches: 'policyName.match_field' },
  },
  'enrichWithClause.newName': { kind: 'new_column' },
  'enrichWithClause.enrichField': {
    kind: 'entity',
    entityType: 'enrich_field',
    constraints: { policy: 'enrichCommand.policyName' },
  },

  'sampleCommand.probability': {
    kind: 'constant',
    valueType: 'double',
    constraints: { greaterThan: '0', lessThan: '1' },
  },

  'changePointCommand.value': { kind: 'column', types: NUMBER_TYPES },
  'changePointCommand.key': { kind: 'column' },
  'changePointCommand.targetType': { kind: 'new_column' },
  'changePointCommand.targetPvalue': { kind: 'new_column' },
  'changePointCommand.booleanExpression': { kind: 'expression' },

  'completionCommand.targetField': { kind: 'new_column' },
  'completionCommand.prompt': {
    kind: 'expression',
    types: STRING_TYPES,
    constraints: { format: 'llm_prompt' },
  },
  'rerankCommand.targetField': { kind: 'new_column' },
  'rerankCommand.queryText': {
    kind: 'constant',
    valueType: 'string',
    constraints: { format: 'search_query' },
  },
  'rerankCommand.rerankFields': { kind: 'expression', types: STRING_TYPES },

  'statsCommand.stats': { kind: 'aggregation' },
  // Groupings: expressions, often a time bucket, that the aggregations can read by name.
  'statsCommand.grouping': { kind: 'expression', constraints: { grouping: 'true' } },
  'inlineStatsCommand.stats': { kind: 'aggregation' },
  'inlineStatsCommand.grouping': { kind: 'expression', constraints: { grouping: 'true' } },

  // A vector the query compares rows with: a literal, a parameter or a function's result, as
  // the `constantOnly` hint of a function parameter.
  'mmrCommand.queryVector': {
    kind: 'expression',
    types: ['dense_vector'],
    constraints: { constantOnly: 'true' },
  },
  'mmrCommand.diversifyField': { kind: 'column', types: ['dense_vector'] },
  'mmrCommand.limitValue': { kind: 'constant', valueType: 'integer' },

  'fuseCommand.fuseType': {
    kind: 'constant',
    valueType: 'identifier',
    allowedValues: ['linear', 'rrf'],
    default: 'rrf',
  },
  'fuseConfiguration.score': { kind: 'column', types: ['double'] },
  'fuseConfiguration.key': { kind: 'column', types: STRING_TYPES },
  'fuseConfiguration.group': { kind: 'column', types: STRING_TYPES },
  'fuseConfiguration.options': {
    kind: 'map',
    parameters: {
      rank_constant: { type: 'integer', default: '60', when: { 'fuseCommand.fuseType': ['rrf'] } },
      normalizer: {
        type: 'keyword',
        values: ['none', 'minmax'],
        when: { 'fuseCommand.fuseType': ['linear'] },
      },
      weights: { type: 'map', when: { 'fuseCommand.fuseType': ['rrf', 'linear'] } },
    },
  },

  'highlightCommand.prefixKeyword': { kind: 'option_name', allowedValues: ['prefix'] },
  'highlightCommand.prefix': { kind: 'constant', valueType: 'string', default: 'highlight_' },
  // A search: a string, or full-text functions such as MATCH, never a bare column.
  'highlightCommand.queryExpression': {
    kind: 'expression',
    types: ['boolean'],
    constraints: { format: 'highlight_text', fullTextQuery: 'true' },
  },
  // `*` alone stands for every text and keyword column.
  'highlightCommand.highlightFields': {
    kind: 'column',
    types: STRING_TYPES,
    constraints: { wildcard: 'alone' },
  },

  'joinTarget.index': { kind: 'entity', entityType: 'lookup_index' },

  'denseVectorNaming.targetField': { kind: 'new_column' },
  'denseVectorNaming.suffixKeyword': { kind: 'option_name', allowedValues: ['suffix'] },
  'denseVectorNaming.suffix': { kind: 'constant', valueType: 'string' },
  'denseVectorNaming.literalInput': { kind: 'constant', valueType: 'string' },
};

/**
 * The role of command arguments the grammar does not label, keyed by `rule>calledRule`, e.g.
 * LIMIT's row count in `limitCommand: LIMIT constant (BY fields)?`.
 */
export const UNLABELLED_ARGUMENT_ROLES: Readonly<Record<string, ArgumentRole>> = {
  // A source name or pattern, with an optional cluster prefix or selector, as `cl:logs-*`.
  'indexPatternOrSubquery>indexPattern': { kind: 'entity', entityType: 'source' },
  // FROM's sources may be subqueries, also nested, as `FROM a, (FROM b, (TS c))`.
  'fromCommand>indexPatternAndMetadataFields': {
    kind: 'entity',
    entityType: 'source',
    constraints: { subqueries: 'true' },
  },
  // TS reads time-series sources only; Elasticsearch rejects subqueries in TS.
  'timeSeriesCommand>indexPatternAndMetadataFields': {
    kind: 'entity',
    entityType: 'source',
    constraints: { indexMode: 'time_series' },
  },
  'limitCommand>constant': { kind: 'constant', valueType: 'integer', constraints: { min: '0' } },
  'limitByGroupKey>booleanExpression': { kind: 'expression' },
  // An aggregation's own filter, `AVG(a) WHERE b > 1`: like WHERE's, complete only as a boolean.
  'aggField>booleanExpression': {
    kind: 'expression',
    types: ['boolean'],
    constraints: { subqueries: 'true', complete: 'boolean' },
  },
  // A filter, complete only as a whole boolean; it may hold subqueries, as
  // `a IN (FROM b | KEEP a)`.
  'whereCommand>booleanExpression': {
    kind: 'expression',
    types: ['boolean'],
    constraints: { subqueries: 'true', complete: 'boolean' },
  },
  // A JOIN condition reads the columns of the input and of the lookup index.
  'joinCondition>booleanExpression': {
    kind: 'expression',
    types: ['boolean'],
    constraints: { columnsOf: 'joinTarget.index' },
  },
  // `name = expression` in a field list (EVAL, STATS, RERANK's ON): the name is a new column.
  'field>qualifiedName': { kind: 'new_column' },
  // EVAL's values, of any type, may hold subqueries; full-text functions only inside SCORE.
  'evalCommand>fields': {
    kind: 'expression',
    types: ['any'],
    constraints: { subqueries: 'true', fullTextOnlyIn: 'score' },
  },
  // ROW has no input, so its values are constants: literals, parameters and functions of them.
  'rowCommand>fields': {
    kind: 'expression',
    types: ['any'],
    constraints: { constantOnly: 'true' },
  },

  'dissectCommand>primaryExpression': { kind: 'column', types: STRING_TYPES },
  'dissectCommand>string': {
    kind: 'constant',
    valueType: 'string',
    constraints: { format: 'dissect_pattern' },
  },
  'dissectCommandOption>identifier': { kind: 'option_name', allowedValues: ['APPEND_SEPARATOR'] },
  'dissectCommandOption>constant': {
    kind: 'constant',
    valueType: 'string',
    constraints: { format: 'separator' },
  },
  'grokCommand>primaryExpression': { kind: 'column', types: STRING_TYPES },
  'grokCommand>string': {
    kind: 'constant',
    valueType: 'string',
    constraints: { format: 'grok_pattern' },
  },

  'uriPartsCommand>qualifiedName': { kind: 'new_column' },
  'uriPartsCommand>primaryExpression': { kind: 'column', types: STRING_TYPES },
  'registeredDomainCommand>qualifiedName': { kind: 'new_column' },
  'registeredDomainCommand>primaryExpression': { kind: 'column', types: STRING_TYPES },

  'userAgentCommand>qualifiedName': { kind: 'new_column' },
  'userAgentCommand>primaryExpression': { kind: 'expression', types: STRING_TYPES },
  'userAgentCommand>commandNamedParameters': {
    kind: 'map',
    parameters: {
      regex_file: { type: 'keyword', default: '_default_' },
      extract_device_type: { type: 'boolean' },
      properties: { type: 'keyword', list: true, values: ['name', 'version', 'os', 'device'] },
    },
  },
  'completionCommand>commandNamedParameters': { kind: 'map', parameters: INFERENCE_PARAMETERS },
  'qualifiedNames>qualifiedName': { kind: 'column', types: STRING_TYPES },
  'fuseKeyByFields>qualifiedName': { kind: 'column', types: STRING_TYPES },
  'denseVectorCommand>commandNamedParameters': {
    kind: 'map',
    parameters: {
      ...INFERENCE_PARAMETERS,
      type: { type: 'keyword', values: ['text', 'image'], default: 'text' },
      timeout: { type: 'keyword', default: '30s' },
    },
  },
  'rerankCommand>commandNamedParameters': { kind: 'map', parameters: INFERENCE_PARAMETERS },
  // `SET <setting> = <value>;`: the value, a constant or a map, is the named setting's.
  'setField>identifier': { kind: 'entity', entityType: 'setting' },
  'setField>constant': { kind: 'setting_value', setting: 'setField>identifier' },
  'setField>mapExpression': { kind: 'setting_value', setting: 'setField>identifier' },
  'mmrCommand>commandNamedParameters': {
    kind: 'map',
    parameters: { lambda: { type: 'double', default: '0.5' } },
  },
  'highlightCommand>commandNamedParameters': {
    kind: 'map',
    parameters: {
      analyzer: { type: 'keyword' },
      pre_tags: { type: 'keyword', default: '<em>' },
      post_tags: { type: 'keyword', default: '</em>' },
      number_of_fragments: { type: 'integer', default: '5' },
      fragment_size: { type: 'integer', default: '100' },
      encoder: { type: 'keyword', values: ['default', 'html'], default: 'default' },
      boundary_scanner: { type: 'keyword', values: ['sentence', 'word'], default: 'sentence' },
      boundary_scanner_locale: { type: 'keyword' },
      order: { type: 'keyword', values: ['none', 'score'], default: 'none' },
      no_match_size: { type: 'integer', default: '0' },
      max_analyzed_offset: { type: 'integer', default: '-1' },
    },
  },
  'ipLocationCommand>qualifiedName': { kind: 'new_column' },
  'ipLocationCommand>primaryExpression': { kind: 'expression', types: ['ip', ...STRING_TYPES] },
  'ipLocationCommand>commandNamedParameters': {
    kind: 'map',
    parameters: {
      database_file: { type: 'keyword', default: 'GeoLite2-City.mmdb' },
      first_only: { type: 'boolean' },
      // The output columns of the database, which the command's output definition lists.
      properties: { type: 'keyword', list: true },
    },
  },
};

/**
 * The role of command arguments that are bare tokens, with no rule to key them by, keyed by
 * `rule>TOKEN`, e.g. the field names in `metadata: METADATA UNQUOTED_SOURCE (COMMA
 * UNQUOTED_SOURCE)*`.
 */
export const TOKEN_ROLES: Readonly<Record<string, ArgumentRole>> = {
  // Elasticsearch rejects a field declared twice.
  'metadata>UNQUOTED_SOURCE': {
    kind: 'entity',
    entityType: 'metadata_field',
    constraints: { unique: 'true' },
  },
};

/**
 * Commands whose arguments the grammar makes optional, though Elasticsearch needs one, as
 * `STATS aggFields? (BY fields)?`: at least an aggregation or a grouping.
 */
export const ARGUMENT_REQUIRED_COMMANDS: readonly string[] = ['statsCommand'];

/**
 * Rules a command repeats in the grammar whose alternatives may each appear only once, as FUSE's
 * `(fuseConfiguration)*`: Elasticsearch rejects a second `SCORE BY`.
 */
export const SINGLE_USE_RULES: readonly string[] = ['fuseConfiguration'];

/**
 * Labelled arguments not classified yet, with why. Each is classified when its command moves
 * to the generic autocomplete.
 */
export const UNCLASSIFIED_ARGUMENTS: Readonly<Record<string, string>> = {
  'lookupCommand.tableName': 'dev-only LOOKUP',
  'lookupCommand.matchFields': 'dev-only LOOKUP',
};

/** Labels inside expressions, names and PROMQL: not command arguments. */
export const NON_ARGUMENT_RULES: readonly string[] = [
  'qualifiedName',
  'qualifiedNamePattern',
  'booleanExpression',
  'matchBooleanExpression',
  'valueExpression',
  'operatorExpression',
  'entryExpression',
  'promqlParam',
];
