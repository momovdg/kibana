/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { GRAMMAR_LABELS } from '../grammar_labels/grammar_labels.generated';
import { getCallSites } from '../grammar_labels/call_sites';
import {
  ARGUMENT_ROLES,
  NON_ARGUMENT_RULES,
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
});
