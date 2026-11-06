/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */
import { markCommonFields } from './utils';
import { ISuggestionItem } from '../types';

describe('markCommonFields()', () => {
  test('returns shared fields between two lists', () => {
    const result = markCommonFields(
      [
        { label: 'id', text: '', kind: 'Field', detail: '' },
        { label: 'currency', text: '', kind: 'Field', detail: '' },
        { label: 'value', text: '', kind: 'Field', detail: '' },
        { label: 'timestamp', text: '', kind: 'Field', detail: '' },
      ],
      [
        { label: 'id', text: '', kind: 'Field', detail: '' },
        { label: 'currency', text: '', kind: 'Field', detail: '' },
        { label: 'name', text: '', kind: 'Field', detail: '' },
      ]
    );

    expect(result.commonFieldLabels.has('id')).toBe(true);
    expect(result.commonFieldLabels.has('currency')).toBe(true);
    expect(result.commonFieldLabels.size).toBe(2);

    const intersection = result.markedSourceSuggestions
      .filter((s) => result.commonFieldLabels.has(s.label))
      .map((s) => ({
        label: s.label,
        text: s.text,
        kind: s.kind,
        detail: s.detail,
      }));

    expect(intersection).toEqual([
      {
        label: 'id',
        text: '',
        kind: 'Field',
        detail: '(common field)',
      },
      {
        label: 'currency',
        text: '',
        kind: 'Field',
        detail: '(common field)',
      },
    ]);
  });

  test('returns empty list if there are no shared fields', () => {
    const result = markCommonFields(
      [
        { label: 'id1', text: '', kind: 'Field', detail: '' },
        { label: 'value', text: '', kind: 'Field', detail: '' },
        { label: 'timestamp', text: '', kind: 'Field', detail: '' },
      ],
      [
        { label: 'id2', text: '', kind: 'Field', detail: '' },
        { label: 'currency', text: '', kind: 'Field', detail: '' },
        { label: 'name', text: '', kind: 'Field', detail: '' },
      ]
    );

    expect(result.commonFieldLabels.size).toBe(0);
  });

  test('returns all fields, if all intersect', () => {
    const result = markCommonFields(
      [
        { label: 'id1', text: '', kind: 'Field', detail: '' },
        { label: 'value', text: '', kind: 'Field', detail: '' },
        { label: 'timestamp', text: '', kind: 'Field', detail: '' },
      ],
      [
        { label: 'id1', text: '', kind: 'Field', detail: '' },
        { label: 'value', text: '', kind: 'Field', detail: '' },
      ]
    );

    expect(result.commonFieldLabels.has('id1')).toBe(true);
    expect(result.commonFieldLabels.has('value')).toBe(true);
    expect(result.commonFieldLabels.size).toBe(2);

    const intersection = result.markedSourceSuggestions
      .filter((s) => result.commonFieldLabels.has(s.label))
      .map((s) => ({
        label: s.label,
        text: s.text,
        kind: s.kind,
        detail: s.detail,
      }));

    expect(intersection).toEqual([
      { label: 'id1', text: '', kind: 'Field', detail: '(common field)' },
      { label: 'value', text: '', kind: 'Field', detail: '(common field)' },
    ]);
  });

  test('creates a clone of suggestions', () => {
    const suggestion1 = {
      label: 'id1',
      text: '',
      kind: 'Field',
      detail: '',
    };
    const suggestion2 = {
      label: 'id1',
      text: '',
      kind: 'Field',
      detail: '',
    };
    const result = markCommonFields(
      [suggestion1] as ISuggestionItem[],
      [suggestion2] as ISuggestionItem[]
    );

    expect(result.commonFieldLabels.has('id1')).toBe(true);
    expect(result.markedSourceSuggestions[0]).not.toBe(suggestion1);
    expect(result.markedSourceSuggestions[0].label).toBe('id1');
  });
});

describe('markCommonFields() - union behavior', () => {
  test('combines two sets without duplicates', () => {
    const result = markCommonFields(
      [
        { label: 'id', text: '', kind: 'Field', detail: '' },
        { label: 'currency', text: '', kind: 'Field', detail: '' },
        { label: 'value', text: '', kind: 'Field', detail: '' },
        { label: 'timestamp', text: '', kind: 'Field', detail: '' },
      ],
      [
        { label: 'id', text: '', kind: 'Field', detail: '' },
        { label: 'currency', text: '', kind: 'Field', detail: '' },
        { label: 'name', text: '', kind: 'Field', detail: '' },
      ]
    );

    const union = [
      ...result.markedSourceSuggestions.map((s) => ({
        label: s.label,
        text: s.text,
        kind: s.kind,
        detail: s.detail,
      })),
      ...result.uniqueLookupSuggestions.map((s) => ({
        label: s.label,
        text: s.text,
        kind: s.kind,
        detail: s.detail,
      })),
    ];

    expect(union).toEqual([
      {
        label: 'id',
        text: '',
        kind: 'Field',
        detail: '(common field)',
      },
      {
        label: 'currency',
        text: '',
        kind: 'Field',
        detail: '(common field)',
      },
      {
        label: 'value',
        text: '',
        kind: 'Field',
        detail: '',
      },
      {
        label: 'timestamp',
        text: '',
        kind: 'Field',
        detail: '',
      },
      {
        label: 'name',
        text: '',
        kind: 'Field',
        detail: '',
      },
    ]);
  });

  test('combines two non-overlapping sets', () => {
    const result = markCommonFields(
      [{ label: 'id', text: '', kind: 'Field', detail: '' }],
      [{ label: 'currency', text: '', kind: 'Field', detail: '' }]
    );

    expect(result.commonFieldLabels.size).toBe(0);

    const union = [
      ...result.markedSourceSuggestions.map((s) => ({
        label: s.label,
        text: s.text,
        kind: s.kind,
        detail: s.detail,
      })),
      ...result.uniqueLookupSuggestions.map((s) => ({
        label: s.label,
        text: s.text,
        kind: s.kind,
        detail: s.detail,
      })),
    ];

    expect(union).toEqual([
      {
        label: 'id',
        text: '',
        kind: 'Field',
        detail: '',
      },
      {
        label: 'currency',
        text: '',
        kind: 'Field',
        detail: '',
      },
    ]);
  });
});
