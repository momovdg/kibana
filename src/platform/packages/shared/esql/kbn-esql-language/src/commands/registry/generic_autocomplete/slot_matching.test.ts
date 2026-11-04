/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { locateCursor } from '../../../language/shared/cursor_location/cursor_location';
import { matchSlots } from './slot_matching';
import type { SlotDefinition, SlotProvider } from './types';

const provide: SlotProvider = async () => [];

const named = (name: string, definition: Omit<SlotDefinition, 'provide'>) => ({
  ...definition,
  provide,
  name,
});

/** The names of the definitions chosen at the end of `text`. */
const chosen = (text: string, definitions: Array<ReturnType<typeof named>>) =>
  matchSlots(locateCursor(text, text.length), definitions).map(
    ({ definition }) => (definition as ReturnType<typeof named>).name
  );

describe('matchSlots', () => {
  const rename = [
    named('new name', { rule: 'qualifiedNamePattern', parent: 'renameClause', after: ['AS'] }),
    named('existing', { rule: 'qualifiedNamePattern', parent: 'renameClause', after: ['ASSIGN'] }),
    named('first name', { rule: 'qualifiedNamePattern', parent: 'renameClause' }),
  ];

  it.each([
    ['FROM a | RENAME a AS ', 'new name'],
    ['FROM a | RENAME a AS b', 'new name'],
    ['FROM a | RENAME a = ', 'existing'],
    ['FROM a | RENAME ', 'first name'],
    ['FROM a | RENAME a AS b, ', 'first name'],
  ])('tells the RENAME slots apart by the previous token at %j', (text, expected) => {
    expect(chosen(text, rename)).toEqual([expected]);
  });

  it('tells the ENRICH slots apart by the parent rule', () => {
    const enrich = [
      named('match field', { rule: 'qualifiedNamePattern', parent: 'enrichCommand' }),
      named('with clause', { rule: 'qualifiedNamePattern', parent: 'enrichWithClause' }),
    ];

    expect(chosen('FROM a | ENRICH pol ON ', enrich)).toEqual(['match field']);
    expect(chosen('FROM a | ENRICH pol WITH ', enrich)).toEqual(['with clause']);
  });

  it('prefers `after` over `parent` over the rule alone', () => {
    const definitions = [
      named('rule', { rule: 'qualifiedNamePattern' }),
      named('parent', { rule: 'qualifiedNamePattern', parent: 'renameClause' }),
      named('after', { rule: 'qualifiedNamePattern', after: ['AS'] }),
    ];

    expect(chosen('FROM a | RENAME a AS ', definitions)).toEqual(['after']);
    expect(chosen('FROM a | RENAME ', definitions)).toEqual(['parent']);
    expect(chosen('FROM a | KEEP ', definitions)).toEqual(['rule']);
  });

  it('picks the earlier definition on a tie, so command definitions beat the defaults', () => {
    const definitions = [
      named('command', { rule: 'qualifiedNamePattern' }),
      named('default', { rule: 'qualifiedNamePattern' }),
    ];

    expect(chosen('FROM a | KEEP ', definitions)).toEqual(['command']);
  });

  it('leaves expression slots to the expression engine', () => {
    const definitions = [
      named('columns', { rule: 'qualifiedName' }),
      named('constants', { rule: 'constant' }),
    ];

    expect(chosen('FROM a | SORT ', definitions)).toEqual([]);
    expect(chosen('FROM a | DISSECT ', definitions)).toEqual([]);
    expect(chosen('FROM a | LIMIT ', definitions)).toEqual(['constants']);
  });

  it('skips a slot the cursor would continue rather than start', () => {
    expect(
      chosen('FROM a | ENRICH pol ON x ', [named('any', { rule: 'qualifiedNamePattern' })])
    ).toEqual([]);
  });

  it('matches every slot expected at one position', () => {
    const definitions = [
      named('target field', { rule: 'qualifiedName', parent: 'completionCommand' }),
    ];

    expect(chosen('FROM a | COMPLETION ', definitions)).toEqual(['target field']);
  });
});
