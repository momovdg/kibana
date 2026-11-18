/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Location } from '../../../commands/registry/types';
import { getExpressionEntry } from '../../../esql_js_sim/definitions';
import { locate } from '../../../esql_js_sim/grammar';
import { offer } from './offer';
import { describeExpressionPosition } from './position';
import type { ExpressionType, Offer, OfferInput } from './types';

const CURSOR = '▮';

/**
 * A rule is given the position and the types and returns data, so it is tested with no
 * editor, no columns and no item: the types of what is written are stated by the test.
 */
const offerAt = (
  marked: string,
  types: Record<string, ExpressionType> = {},
  fields: Partial<OfferInput> = {}
): Offer => {
  const offset = marked.indexOf(CURSOR);
  const text = marked.replace(CURSOR, '');
  const ir = locate(text, offset);
  const path = [...ir.arguments, ...ir.followers].map((expected) => expected.path);
  const entry = path.map(getExpressionEntry).find((found) => found !== undefined) ?? '';
  const typeOf: OfferInput['typeOf'] = ({ start, end }) =>
    types[text.slice(start, end).trim()] ?? 'unknown';
  const position = describeExpressionPosition(ir, entry);

  return offer({
    ir,
    position,
    offset,
    textBefore: text.slice(0, offset),
    preferred: [],
    allowsSubquery: false,
    readsColumns: true,
    listedColumns: [],
    location: Location.WHERE,
    expressionType:
      position.start === undefined ? 'unknown' : typeOf({ start: position.start, end: offset }),
    typeOf,
    getParameter: () => null,
    ...fields,
  });
};

describe('what is offered inside an expression', () => {
  it('is every operand where an expression starts', () => {
    expect(offerAt('FROM a | WHERE ▮')).toEqual({
      operands: { types: ['any'], columns: true, ignoredColumns: [], spaced: true },
    });
  });

  it('is only operands of the types a role asks for, when it asks for no boolean', () => {
    expect(offerAt('FROM a | WHERE ▮', {}, { preferred: ['keyword'] }).operands?.types).toEqual([
      'keyword',
    ]);
  });

  it('leaves the columns out where the role reads none', () => {
    expect(offerAt('FROM a | WHERE ▮', {}, { readsColumns: false }).operands?.columns).toBe(false);
  });

  it('is the operators for the type of the operand after an operand', () => {
    expect(offerAt('FROM a | WHERE n ▮', { n: 'integer' })).toEqual({
      operators: { after: 'integer', allowed: undefined, ignored: ['='] },
      items: [],
    });
  });

  it('is nothing after an operand whose type is not known', () => {
    expect(offerAt('FROM a | WHERE n ▮')).toEqual({});
  });

  it('is the operands an operator takes on its right for the type on its left', () => {
    const { operands } = offerAt('FROM a | WHERE n > ▮', { n: 'integer' });

    expect(operands).toMatchObject({ columns: true, spaced: true, literals: 'exact' });
    expect(operands?.types).toEqual(expect.arrayContaining(['integer', 'double']));
    expect(operands?.types).not.toContain('keyword');
  });

  it('is the operators that join conditions after a whole condition', () => {
    const { operators } = offerAt('FROM a | WHERE n > 1 ▮', {
      n: 'integer',
      '1': 'integer',
      'n > 1': 'boolean',
    });

    expect(operators?.allowed).toEqual(['and', 'or']);
  });

  it('is the ways to finish a null check that is started', () => {
    const { items = [] } = offerAt('FROM a | WHERE n IS ▮', { n: 'integer' });

    expect(items.map(({ label }) => label)).toEqual(['IS NULL', 'IS NOT NULL']);
  });

  it('is the opening of the list after IN', () => {
    const { items = [] } = offerAt('FROM a | WHERE n IN ▮', { n: 'integer' });

    expect(items.map(({ text }) => text)).toEqual(['($0)']);
  });

  it('is the values of the type of the column inside the list of IN', () => {
    expect(offerAt('FROM a | WHERE n IN (1, ▮', { n: 'integer' }).operands).toEqual({
      types: ['integer'],
      columns: true,
      ignoredColumns: ['n'],
      spaced: true,
      literals: 'compatible',
    });
  });

  it('is left to the query language of the string inside a string', () => {
    expect(offerAt('FROM a | WHERE KQL("▮')).toEqual({ whole: 'string' });
  });
});
