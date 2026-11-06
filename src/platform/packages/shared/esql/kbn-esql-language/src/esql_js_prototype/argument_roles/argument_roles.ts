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
  'statsCommand.grouping': { kind: 'expression' },
  'inlineStatsCommand.stats': { kind: 'aggregation' },
  'inlineStatsCommand.grouping': { kind: 'expression' },

  'mmrCommand.diversifyField': { kind: 'column' },
  'mmrCommand.limitValue': { kind: 'constant', valueType: 'integer' },

  'joinTarget.index': { kind: 'entity', entityType: 'lookup_index' },
};

/**
 * The role of command arguments the grammar does not label, keyed by `rule>calledRule`, e.g.
 * LIMIT's row count in `limitCommand: LIMIT constant (BY fields)?`.
 */
export const UNLABELLED_ARGUMENT_ROLES: Readonly<Record<string, ArgumentRole>> = {
  'limitCommand>constant': { kind: 'constant', valueType: 'integer', constraints: { min: '0' } },
  'limitByGroupKey>booleanExpression': { kind: 'expression' },

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
  'rerankCommand>commandNamedParameters': { kind: 'map', parameters: INFERENCE_PARAMETERS },
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
 * Labelled arguments not classified yet, with why. Each is classified when its command moves
 * to the generic autocomplete.
 */
export const UNCLASSIFIED_ARGUMENTS: Readonly<Record<string, string>> = {
  'fuseCommand.fuseType': 'a fusion method (rrf, linear); check with FUSE',
  'fuseConfiguration.score': 'check with FUSE',
  'fuseConfiguration.key': 'check with FUSE',
  'fuseConfiguration.group': 'check with FUSE',
  'fuseConfiguration.options': 'a map of options; check with FUSE',
  'lookupCommand.tableName': 'dev-only LOOKUP',
  'lookupCommand.matchFields': 'dev-only LOOKUP',
  'highlightCommand.prefixKeyword': 'check with HIGHLIGHT',
  'highlightCommand.queryExpression': 'check with HIGHLIGHT',
  'highlightCommand.highlightFields': 'check with HIGHLIGHT',
  'mmrCommand.queryVector': 'a vector or expression; check with MMR',
  'denseVectorNaming.targetField': 'check with DENSE_VECTOR',
  'denseVectorNaming.suffixKeyword': 'check with DENSE_VECTOR',
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
