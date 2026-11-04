/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { esqlCommandRegistry } from '../../commands/registry';
import { autocomplete as keepAutocomplete } from '../../commands/registry/keep/autocomplete';
import type { ISuggestionItem } from '../../commands/registry/types';
import type { CommandAutocomplete } from '../../commands/registry/generic_autocomplete/generic_autocomplete';
import {
  bothImplementations,
  compareAtEveryOffset,
  compareThroughSuggest,
  formatParityReport,
  queryVariants,
} from './parity';

const returning =
  (items: ISuggestionItem[]): CommandAutocomplete =>
  async () =>
    items;

const item = (text: string, extra: Partial<ISuggestionItem> = {}): ISuggestionItem => ({
  label: text,
  text,
  kind: 'Keyword',
  detail: '',
  ...extra,
});

describe('parity harness', () => {
  it('builds the variants the regexes tended to miss', () => {
    expect(
      queryVariants('FROM a | SORT keywordField ASC, doubleField | LIMIT 1', {
        commandName: 'sort',
        columns: ['keywordField'],
      })
    ).toEqual([
      'FROM a | SORT keywordField ASC, doubleField | LIMIT 1',
      'from a | sort keywordField asc, doubleField | limit 1',
      'FROM a\n| SORT keywordField ASC, doubleField\n| LIMIT 1',
      'FROM a | SORT keywordField ASC,doubleField | LIMIT 1',
      'FROM a | SORT /* c */ keywordField /* c */ ASC, /* c */ doubleField /* c */ | /* c */ LIMIT /* c */ 1',
      'FROM a | SORT `keywordField` ASC, doubleField | LIMIT 1',
    ]);
  });

  it('checks every cursor offset after the command keyword', async () => {
    const same = returning([item('a')]);
    const report = await compareAtEveryOffset({
      commandName: 'keep',
      legacy: same,
      generic: same,
      queries: ['FROM a | KEEP ab'],
    });

    // After `KEEP`, after the space, after `a`, after `ab`.
    expect(report).toEqual({ positions: 4, differences: [] });
  });

  it('stops at the pipe that ends the command, not at one inside parentheses', async () => {
    const same = returning([item('a')]);
    const positions = async (query: string, commandName: string) =>
      (await compareAtEveryOffset({ commandName, legacy: same, generic: same, queries: [query] }))
        .positions;

    // `KEEP`, ` `, `a`, ` ` and then the pipe of the next command.
    expect(await positions('FROM a | KEEP a | LIMIT 1', 'keep')).toBe(4);
    expect(await positions('FROM a | FORK (KEEP a | LIMIT 1) | LIMIT 2', 'fork')).toBe(
      ' (KEEP a | LIMIT 1) '.length + 1
    );
  });

  it('tells differences the editor shows from those its filter hides', async () => {
    const report = await compareAtEveryOffset({
      commandName: 'keep',
      legacy: returning([item('keywordField')]),
      generic: returning([item('keywordField'), item('doubleField')]),
      queries: ['FROM a | KEEP k'],
    });
    const shownAt = (text: string) =>
      report.differences.find(({ textBeforeCursor }) => textBeforeCursor === text)?.shown;

    // With nothing typed both lists are shown; after `k`, `doubleField` is filtered out.
    expect(shownAt('FROM a | KEEP ')).toBe(true);
    expect(shownAt('FROM a | KEEP k')).toBe(false);
  });

  it('filters by the text in the replacement range, as the editor does', async () => {
    const query = 'FROM a | SORT b /* c */ ';
    const report = await compareAtEveryOffset({
      commandName: 'sort',
      legacy: returning([]),
      generic: returning([item('ASC', { rangeToReplace: { start: 16, end: query.length } })]),
      queries: [query],
    });
    const atEnd = report.differences.find(({ textBeforeCursor }) => textBeforeCursor === query);

    // The range covers `/* c */ `, which does not match `ASC`, so the editor hides it.
    expect(atEnd?.shown).toBe(false);
  });

  it('compares through the full suggest() and restores the registered command', async () => {
    const keep = esqlCommandRegistry.getCommandByName('keep')!;
    const { methods, autocompleteSpec } = keep;

    const report = await compareThroughSuggest({
      commandName: 'keep',
      legacy: keepAutocomplete,
      spec: {},
      queries: ['FROM a | KEEP '],
    });

    expect(report.positions).toBe(2);
    expect(keep.methods).toBe(methods);
    expect(keep.autocompleteSpec).toBe(autocompleteSpec);
  });

  it('formats a report with the shown differences first', async () => {
    const report = await compareAtEveryOffset({
      commandName: 'keep',
      legacy: returning([item('a')]),
      generic: returning([item('b')]),
      queries: ['FROM a | KEEP '],
    });

    // Right after `KEEP` the range covers `KEEP`, which matches neither item.
    expect(formatParityReport(report)).toBe(
      [
        'positions=2 differences=2 shown=1',
        '--- shown after the editor filters',
        '"FROM a | KEEP " (command)\n    legacy:  a@14-14\n    generic: b@14-14',
        '--- hidden by the editor filter',
        '"FROM a | KEEP" (command)\n    legacy:  a@9-13\n    generic: b@9-13',
      ].join('\n')
    );
  });

  it('pairs the legacy and generic implementations for describe.each', () => {
    const [[legacyName, legacy], [genericName]] = bothImplementations(keepAutocomplete, {});

    expect([legacyName, genericName]).toEqual(['legacy', 'generic']);
    expect(legacy).toBe(keepAutocomplete);
  });
});
