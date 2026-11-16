/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { readOptionShell } from './option_shell';

const NAMES = ['index', 'step', 'start'];

const read = (text: string) => readOptionShell(text, text.length, 0, NAMES);

/** The options as `name=value1|value2`, with a `*` after the one the cursor is at. */
const summary = (text: string): string[] =>
  read(text).options.map(
    ({ name, values, open }) =>
      `${name.text}=${values.map((value) => value.text).join('|')}${open ? '*' : ''}`
  );

describe('readOptionShell', () => {
  it('reads nothing right after the name of the command', () => {
    expect(read('PROMQL ')).toEqual({ options: [] });
  });

  it('reads an option whose value is still to come as the one at the cursor', () => {
    expect(summary('PROMQL step=')).toEqual(['step=*']);
    expect(summary('PROMQL step = ')).toEqual(['step=*']);
  });

  it('reads a value that is being typed as still at the cursor, and one followed by a space as done', () => {
    expect(summary('PROMQL step=5')).toEqual(['step=5*']);
    expect(summary('PROMQL step=5m ')).toEqual(['step=5m']);
  });

  it('reads a list of values, which goes on after a separator', () => {
    expect(summary('PROMQL index=a, b')).toEqual(['index=a|b*']);
    expect(summary('PROMQL index=a, ')).toEqual(['index=a*']);
    expect(summary('PROMQL index=a,b step=5m ')).toEqual(['index=a|b', 'step=5m']);
  });

  it('keeps what is glued to a value with it', () => {
    expect(summary('PROMQL index=logs-tsdb ')).toEqual(['index=logs-tsdb']);
    expect(summary('PROMQL start="2024-01-01" ')).toEqual(['start="2024-01-01"']);
  });

  it('takes a name by any case, and only the names it is given', () => {
    expect(summary('PROMQL STEP=5m ')).toEqual(['STEP=5m']);
    expect(read('PROMQL other=5m ')).toMatchObject({ options: [], bodyStart: 7 });
  });

  it('says where the body starts: at the first thing that is no option', () => {
    expect(read('PROMQL step=5m rate(')).toMatchObject({ bodyStart: 15 });
    expect(read('PROMQL col0 = (')).toMatchObject({ options: [], bodyStart: 7 });
    expect(read('PROMQL step')).toMatchObject({ options: [], bodyStart: 7 });
  });

  it('ends a value in quotes at its closing quote', () => {
    expect(summary('PROMQL start="2024-01-01"step')).toEqual(['start="2024-01-01"']);
  });

  describe('the body', () => {
    it('can be given a name, and be put in brackets of the command', () => {
      expect(read('PROMQL col0 = (rate(a')).toMatchObject({
        result: { text: 'col0' },
        wrapped: true,
        textStart: 15,
      });
      expect(read('PROMQL rate(a')).toMatchObject({ wrapped: false, textStart: 7 });
    });

    it('ends where the brackets of the command close', () => {
      expect(read('PROMQL (rate(a[5m]))')).toMatchObject({ wrapped: true, textEnd: 19 });
    });

    it('keeps a bracket that closes before its end: it belongs to the text', () => {
      expect(read('PROMQL (a) + ')).toMatchObject({ wrapped: false, textStart: 7 });
    });
  });
});
