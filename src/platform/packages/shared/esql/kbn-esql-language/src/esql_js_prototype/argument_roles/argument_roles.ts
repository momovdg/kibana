/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ArgumentRole } from './types';

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

  'changePointCommand.value': { kind: 'column' },
  'changePointCommand.key': { kind: 'column' },
  'changePointCommand.targetType': { kind: 'new_column' },
  'changePointCommand.targetPvalue': { kind: 'new_column' },

  'completionCommand.targetField': { kind: 'new_column' },
  'completionCommand.prompt': { kind: 'expression' },
  'rerankCommand.targetField': { kind: 'new_column' },
  'rerankCommand.queryText': { kind: 'constant', valueType: 'string' },

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
};

/**
 * Labelled arguments not classified yet, with why. Each is classified when its command moves
 * to the generic autocomplete.
 */
export const UNCLASSIFIED_ARGUMENTS: Readonly<Record<string, string>> = {
  'changePointCommand.booleanExpression': 'grouping after BY; check with CHANGE_POINT',
  'rerankCommand.rerankFields': 'a list of fields or expressions; check with RERANK',
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
