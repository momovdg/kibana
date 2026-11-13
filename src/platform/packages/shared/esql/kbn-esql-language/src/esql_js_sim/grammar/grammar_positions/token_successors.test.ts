/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { getTokenSuccessors } from './token_successors';

const texts = (rule: string, token: string): string[] =>
  getTokenSuccessors(rule, token)
    .tokens.map(({ text, token: name }) => text ?? name)
    .sort();

describe('getTokenSuccessors', () => {
  it('gives the keywords that have to follow a keyword', () => {
    const { tokens, canEnd } = getTokenSuccessors('orderExpression', 'NULLS');

    expect(tokens.map(({ text }) => text).sort()).toEqual(['first', 'last']);
    expect(tokens.every((token) => token.class === 'keyword')).toBe(true);
    expect(canEnd).toBe(false);
  });

  it('says when nothing has to follow a token', () => {
    expect(getTokenSuccessors('orderExpression', 'ASC').canEnd).toBe(true);
    expect(getTokenSuccessors('orderExpression', 'FIRST').canEnd).toBe(true);
  });

  it('enters the rule that is called next for its first token', () => {
    // After WITH comes a map, which starts with its opening brace.
    expect(texts('commandNamedParameters', 'WITH')).toEqual(['{']);
    expect(getTokenSuccessors('commandNamedParameters', 'WITH').canEnd).toBe(false);
  });

  it('gives tokens with no fixed text as what they are', () => {
    const { tokens, canEnd } = getTokenSuccessors('limitCommand', 'LIMIT');

    expect(tokens.some((token) => token.class === 'value')).toBe(true);
    expect(canEnd).toBe(false);
  });

  it('gives nothing for a token the rule does not take', () => {
    expect(getTokenSuccessors('limitCommand', 'NULLS')).toEqual({ tokens: [], canEnd: false });
  });
});
