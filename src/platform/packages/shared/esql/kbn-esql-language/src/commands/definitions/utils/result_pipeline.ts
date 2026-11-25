/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isSource, isSubQuery } from '@elastic/esql';
import type { ESQLAstCommand, ESQLAstForkCommand, ESQLSource } from '@elastic/esql/types';
import { TRANSFORMATIONAL_COMMANDS } from '../../../constants';
import {
  findNamedSubqueryForSource,
  getNamedSubqueriesAvailableTo,
  type NamedSubquery,
} from './named_subqueries';

export type EsqlResultRowKind =
  | 'document'
  | 'schema'
  | 'aggregate'
  | 'schema-aggregate'
  | 'unknown';
export type EsqlResultRows = ReadonlySet<EsqlResultRowKind>;

const UNKNOWN_ROWS: EsqlResultRows = new Set(['unknown']);
const DOCUMENT_ROWS: EsqlResultRows = new Set(['document']);
const SCHEMA_ROWS: EsqlResultRows = new Set(['schema']);
const AGGREGATE_ROWS: EsqlResultRows = new Set(['aggregate']);

const isSchemaDerivedRow = (kind: EsqlResultRowKind): boolean =>
  kind === 'schema' || kind === 'schema-aggregate';

/** Checks whether any possible output row is schema-derived. */
export const hasSchemaDerivedRows = (rows: EsqlResultRows): boolean =>
  [...rows].some(isSchemaDerivedRow);

/** Checks whether schema-derived rows contribute to a table-only result. */
export const isSchemaTableResult = (rows: EsqlResultRows): boolean =>
  hasSchemaDerivedRows(rows) && !rows.has('document') && !rows.has('unknown');

export interface EsqlResultPipeline {
  readonly rows: EsqlResultRows;
  readonly usesResultColumns: boolean;
}

function resultPipeline(rows: EsqlResultRows): EsqlResultPipeline {
  return { rows, usesResultColumns: !rows.has('document') && !rows.has('unknown') };
}

function combineResults(results: readonly EsqlResultPipeline[]): EsqlResultPipeline {
  if (!results.length) return resultPipeline(UNKNOWN_ROWS);
  return {
    rows: new Set(results.flatMap(({ rows }) => [...rows])),
    usesResultColumns: results.every((result) => result.usesResultColumns),
  };
}

/** Follows the pipelines that supply output rows and their default display columns. */
export function analyzeResultPipeline(
  commands: readonly ESQLAstCommand[],
  namedSubqueries: readonly NamedSubquery[] = []
): EsqlResultPipeline {
  const bindingResults = new Map<NamedSubquery, EsqlResultPipeline>();

  function getSourceResult(
    source: ESQLSource,
    bindings: readonly NamedSubquery[]
  ): EsqlResultPipeline {
    const binding = findNamedSubqueryForSource(source, bindings);
    if (!binding) {
      return resultPipeline(DOCUMENT_ROWS);
    }

    const cached = bindingResults.get(binding);
    if (cached) {
      return cached;
    }

    const result = analyze(
      binding.query.commands,
      getNamedSubqueriesAvailableTo(bindings, binding)
    );
    bindingResults.set(binding, result);
    return result;
  }

  function analyze(
    pipeline: readonly ESQLAstCommand[],
    bindings: readonly NamedSubquery[],
    input = resultPipeline(UNKNOWN_ROWS)
  ): EsqlResultPipeline {
    return pipeline.reduce<EsqlResultPipeline>((result, command) => {
      switch (command.name) {
        case 'from':
          return combineResults(
            command.args.flatMap((arg) => {
              if (isSubQuery(arg)) {
                return [analyze(arg.child.commands, bindings)];
              }
              return isSource(arg) ? [getSourceResult(arg, bindings)] : [];
            })
          );
        case 'fork': {
          const { args } = command as ESQLAstForkCommand;
          if (!args.length) return result;
          const branches = combineResults(
            args.map(({ child }) =>
              child.type === 'query' ? analyze(child.commands, bindings, result) : result
            )
          );
          // Discover also shows result columns when every branch consists solely of KEEP, STATS or PROMQL.
          const legacyFork = args.every(
            ({ child }) =>
              child.type === 'query' &&
              child.commands.length > 0 &&
              child.commands.every(({ name }) => TRANSFORMATIONAL_COMMANDS.includes(name))
          );
          return { ...branches, usesResultColumns: branches.usesResultColumns || legacyFork };
        }
        case 'describe':
          return resultPipeline(SCHEMA_ROWS);
        case 'stats':
          return resultPipeline(
            new Set(
              Array.from(result.rows, (kind) =>
                isSchemaDerivedRow(kind) ? 'schema-aggregate' : 'aggregate'
              )
            )
          );
        case 'promql':
          return resultPipeline(AGGREGATE_ROWS);
        default:
          return result;
      }
    }, input);
  }

  return analyze(commands, namedSubqueries);
}

/** Identifies the row kinds emitted by the result-producing sources. */
export function analyzeResultRows(
  commands: readonly ESQLAstCommand[],
  namedSubqueries: readonly NamedSubquery[] = []
): EsqlResultRows {
  return analyzeResultPipeline(commands, namedSubqueries).rows;
}
