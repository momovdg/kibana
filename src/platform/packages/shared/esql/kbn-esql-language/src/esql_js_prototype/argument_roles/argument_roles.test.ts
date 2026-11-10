/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { GRAMMAR_LABELS } from '../grammar_labels/grammar_labels.generated';
import { getCallSites, ruleMatchesToken } from '../grammar_labels/call_sites';
import { getArgumentRole, getTokenRole } from '..';
import {
  ARGUMENT_ROLES,
  NON_ARGUMENT_RULES,
  TOKEN_ROLES,
  UNCLASSIFIED_ARGUMENTS,
  UNLABELLED_ARGUMENT_ROLES,
} from './argument_roles';

const argumentKeys = new Set(
  GRAMMAR_LABELS.filter(({ rule }) => !NON_ARGUMENT_RULES.includes(rule)).map(
    ({ rule, label }) => `${rule}.${label}`
  )
);

describe('argument roles', () => {
  it('cover every labelled command argument, or list it as unclassified', () => {
    const missing = [...argumentKeys].filter(
      (key) => !(key in ARGUMENT_ROLES) && !(key in UNCLASSIFIED_ARGUMENTS)
    );

    expect(missing).toEqual([]);
  });

  it('name only labels of the grammar', () => {
    const unknown = [...Object.keys(ARGUMENT_ROLES), ...Object.keys(UNCLASSIFIED_ARGUMENTS)].filter(
      (key) => !argumentKeys.has(key)
    );

    expect(unknown).toEqual([]);
  });

  it('classify an argument at most once', () => {
    expect(Object.keys(ARGUMENT_ROLES).filter((key) => key in UNCLASSIFIED_ARGUMENTS)).toEqual([]);
  });

  it('key unlabelled arguments by unlabelled calls of the grammar', () => {
    const unknown = Object.keys(UNLABELLED_ARGUMENT_ROLES).filter((key) => {
      const [rule, invokes] = key.split('>');
      const sites = getCallSites(rule, invokes);
      return !sites.length || sites.some(({ label }) => label);
    });

    expect(unknown).toEqual([]);
  });

  it('key token arguments by tokens their rule matches', () => {
    const unknown = Object.keys(TOKEN_ROLES).filter((key) => {
      const [rule, token] = key.split('>');
      return !ruleMatchesToken(rule, token);
    });

    expect(unknown).toEqual([]);
  });

  describe('sources', () => {
    const roleOf = (rule: string, invokes: string) =>
      getCallSites(rule, invokes).map((site) => getArgumentRole(site));

    it('are source entities, in FROM, TS and their lists', () => {
      expect(roleOf('indexPatternOrSubquery', 'indexPattern')).toEqual([
        { kind: 'entity', entityType: 'source' },
      ]);
      expect(roleOf('fromCommand', 'indexPatternAndMetadataFields')).toEqual([
        expect.objectContaining({ kind: 'entity', entityType: 'source' }),
      ]);
      expect(roleOf('timeSeriesCommand', 'indexPatternAndMetadataFields')).toEqual([
        expect.objectContaining({ kind: 'entity', entityType: 'source' }),
      ]);
    });

    it('are time-series sources in TS only', () => {
      const [fromRole] = roleOf('fromCommand', 'indexPatternAndMetadataFields');
      const [tsRole] = roleOf('timeSeriesCommand', 'indexPatternAndMetadataFields');

      expect(fromRole).not.toHaveProperty('constraints.indexMode');
      expect(tsRole).toHaveProperty('constraints.indexMode', 'time_series');
    });

    it('may be subqueries in FROM only', () => {
      const [fromRole] = roleOf('fromCommand', 'indexPatternAndMetadataFields');
      const [tsRole] = roleOf('timeSeriesCommand', 'indexPatternAndMetadataFields');

      expect(fromRole).toHaveProperty('constraints.subqueries', 'true');
      expect(tsRole).not.toHaveProperty('constraints.subqueries');
    });
  });

  it('make METADATA fields unique metadata fields', () => {
    expect(getTokenRole('metadata', 'UNQUOTED_SOURCE')).toEqual({
      kind: 'entity',
      entityType: 'metadata_field',
      constraints: { unique: 'true' },
    });
    expect(getTokenRole('metadata', 'COMMA')).toBeUndefined();
  });
});
