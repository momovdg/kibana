/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { expectSuggestions, getFieldNamesByType } from '../../../__tests__/commands/autocomplete';
import { indexes, integrations, mockContext } from '../../../__tests__/commands/context_fixtures';
import { CPS_METADATA_FIELDS, METADATA_FIELDS } from '../options/metadata';
import {
  getRecommendedQueriesTemplates,
  getRecommendedQueriesTemplatesFromExtensions,
} from '../options/recommended_queries';
import type { ICommandCallbacks } from '../types';
import { genericAutocomplete as autocomplete } from '../generic_autocomplete/command_autocomplete';
import { findAutocompleteAstPosition } from '../../../language/shared/parse_for_autocomplete_query';

const metadataFields = [...METADATA_FIELDS].sort();

const fromExpectSuggestions = (
  query: string,
  expectedSuggestions: string[],
  mockCallbacks?: ICommandCallbacks,
  context = mockContext,
  offset?: number
) => {
  return expectSuggestions(
    query,
    expectedSuggestions,
    context,
    'from',
    mockCallbacks,
    autocomplete,
    offset
  );
};

const subquerySuggestions = ['(FROM $0)', '(ROW $0)', '(TS $0)'];

const visibleIndices =
  mockContext.sources?.filter((source) => !source.hidden).map((source) => source.name) || [];

const visibleIntegrations = integrations.map((name) => ({
  name,
  hidden: name.startsWith('.'),
  type: 'Integration',
}));
const visibleDataSources = [...(mockContext.sources ?? []), ...visibleIntegrations].filter(
  (source) => !source.hidden
);

describe('FROM Autocomplete', () => {
  let mockCallbacks: ICommandCallbacks;
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mockContext.sources to original indexes
    mockContext.sources = indexes.map((name) => ({
      name,
      hidden: name.startsWith('.'),
      type: 'Index',
    }));

    // Reset mocks before each test to ensure isolation
    mockCallbacks = {
      getByType: jest.fn(),
    };

    const expectedFields = getFieldNamesByType('any', true);
    (mockCallbacks.getByType as jest.Mock).mockResolvedValue(
      expectedFields.map((name) => ({ label: name, text: name }))
    );
  });
  describe('... <sources> ...', () => {
    test('suggests Browse data sources in empty source slots when enabled', async () => {
      mockCallbacks = {
        ...mockCallbacks,
        canSuggestResourceBrowser: jest.fn().mockResolvedValue(true),
      };

      const suggest = async (query: string) => {
        const cursorPosition = query.length;
        const { command } = findAutocompleteAstPosition(query, cursorPosition);
        return autocomplete(query, command!, mockCallbacks, mockContext, cursorPosition);
      };

      const initialSlotLabels = (await suggest('FROM ')).map((s) => s.label);
      expect(initialSlotLabels[0]).toBe('Browse data sources');

      const afterCommaLabels = (await suggest('FROM index, ')).map((s) => s.label);
      expect(afterCommaLabels[0]).toBe('Browse data sources');

      // Not while a name is typed, nor in a subquery.
      expect((await suggest('FROM ind')).map((s) => s.label)).not.toContain('Browse data sources');
    });

    test('suggests visible indices on space', async () => {
      await fromExpectSuggestions(
        'from /',
        [...visibleIndices, ...subquerySuggestions],
        mockCallbacks
      );
      await fromExpectSuggestions(
        'FROM /',
        [...visibleIndices, ...subquerySuggestions],
        mockCallbacks
      );
      await fromExpectSuggestions(
        'from /index',
        [...visibleIndices, ...subquerySuggestions],
        mockCallbacks
      );
    });

    test("doesn't create suggestions after an open quote", async () => {
      await fromExpectSuggestions('FROM " "', [], mockCallbacks, mockContext, 6);
    });

    test('does create suggestions after a closed quote', async () => {
      await fromExpectSuggestions(
        'FROM "lolz", ',
        [...visibleIndices, ...subquerySuggestions],
        mockCallbacks
      );
    });

    test('doesnt suggest indices twice', async () => {
      await fromExpectSuggestions(
        'from index, ',
        [...visibleIndices.filter((i) => i !== 'index'), ...subquerySuggestions],
        mockCallbacks
      );
    });

    test('suggests comma or pipe after complete index name', async () => {
      const suggest = async (query: string) => {
        const cursorPosition = query.length;
        const { command } = findAutocompleteAstPosition(query, cursorPosition);
        return autocomplete(query, command!, mockCallbacks, mockContext, cursorPosition);
      };
      // While the name is typed, the follow-ups keep it.
      const suggestions = await suggest('from index');
      const kept = suggestions.filter(({ preserveTypedPrefix }) => preserveTypedPrefix);

      expect(kept.map(({ text }) => text)).toEqual(expect.arrayContaining([', ', ' | ']));

      // After a closing quote, they follow it.
      const suggestions2 = (await suggest('from index, "my-index"')).map((s) => s.text);

      expect(suggestions2).toEqual(expect.arrayContaining([', ', ' | ']));
    });

    test('can suggest integration data sources', async () => {
      const expectedSuggestions = visibleDataSources.map((source) => source.name);
      mockContext.sources = visibleDataSources;

      await fromExpectSuggestions(
        'from ',
        [...expectedSuggestions, ...subquerySuggestions],
        mockCallbacks
      );
      await fromExpectSuggestions(
        'FROM ',
        [...expectedSuggestions, ...subquerySuggestions],
        mockCallbacks
      );
      await fromExpectSuggestions(
        'FROM a,/',
        [...expectedSuggestions.filter((i) => i !== 'a'), ...subquerySuggestions],
        mockCallbacks
      );
      await fromExpectSuggestions(
        'from a, /',
        [...expectedSuggestions.filter((i) => i !== 'a'), ...subquerySuggestions],
        mockCallbacks
      );
      await fromExpectSuggestions(
        'from *,/',
        [...expectedSuggestions, ...subquerySuggestions],
        mockCallbacks
      );
    });

    describe('on the generic autocomplete', () => {
      const suggestWith = async (query: string, context = mockContext) => {
        const { command } = findAutocompleteAstPosition(query, query.length);
        return autocomplete(query, command!, mockCallbacks, context, query.length);
      };
      const contextWithTimeSeries = {
        ...mockContext,
        sources: [
          { name: 'logs', hidden: false, type: 'Index' },
          { name: 'metrics-tsdb', hidden: false, type: 'Timeseries' },
        ],
      };

      test('rewrites FROM to TS when a time-series source is picked as the only one', async () => {
        // The item's command (serialized with the one reopening suggestions) replaces the
        // command keyword and the source with `TS <source>`.
        const rewrites = async (query: string) =>
          JSON.stringify(
            (await suggestWith(query, contextWithTimeSeries)).find(
              ({ label }) => label === 'metrics-tsdb'
            )?.command ?? {}
          ).includes('TS metrics-tsdb');

        expect(await rewrites('FROM ')).toBe(true);
        expect(await rewrites('FROM met')).toBe(true);
        expect(await rewrites('FROM logs, ')).toBe(false);
      });

      test('leaves time-series sources out of a subquery', async () => {
        const labels = (
          await suggestWith('FROM a, (FROM ', {
            ...contextWithTimeSeries,
            isCursorInSubquery: true,
          })
        ).map(({ label }) => label);

        expect(labels).toContain('logs');
        expect(labels).not.toContain('metrics-tsdb');
      });

      test("suggests an integration's data streams once it is typed in full", async () => {
        const context = {
          ...mockContext,
          sources: [
            {
              name: 'nginx',
              hidden: false,
              type: 'Integration',
              dataStreams: [{ name: 'logs-nginx.access-*' }, { name: 'logs-nginx.error-*' }],
            },
          ],
        };

        expect((await suggestWith('FROM nginx', context)).map(({ text }) => text)).toEqual([
          'logs-nginx.access-*',
          'logs-nginx.error-*',
          ...subquerySuggestions,
        ]);
      });

      test('suggests sources while a pattern with a dash is typed', async () => {
        const labels = (await suggestWith('FROM my-')).map(({ label }) => label);

        expect(labels).toContain('my-index');
      });

      test('suggests the recommended queries after a complete source, typed or followed by a space', async () => {
        const isRecommendedQuery = ({ category }: { category?: string }) =>
          category === 'recommended_query';

        expect((await suggestWith('FROM index')).some(isRecommendedQuery)).toBe(true);
        expect((await suggestWith('FROM index ')).some(isRecommendedQuery)).toBe(true);
        expect((await suggestWith('FROM index METADATA _id ')).some(isRecommendedQuery)).toBe(
          false
        );
      });
    });

    test('suggests views from context.views alongside sources', async () => {
      const contextWithViews = {
        ...mockContext,
        views: [
          { name: 'my_saved_view', query: 'FROM logs | LIMIT 10' },
          { name: 'my-view', query: 'FROM metrics' },
        ],
      };
      const expectedFromSources = visibleIndices;
      const expectedFromViews = ['my_saved_view', 'my-view'];
      await fromExpectSuggestions(
        'from ',
        [...expectedFromSources, ...expectedFromViews, ...subquerySuggestions],
        mockCallbacks,
        contextWithViews
      );
      // View names appear when typing (fragment "my_")
      const getSuggestions = async (query: string) => {
        const cursorPosition = query.length;
        const { command } = findAutocompleteAstPosition(query, cursorPosition);
        return autocomplete(query, command!, mockCallbacks, contextWithViews, cursorPosition);
      };
      const suggestions = (await getSuggestions('FROM my_')).map((s) => s.text);
      expect(suggestions).toContain('my_saved_view');
      expect(suggestions).toContain('my-view');
    });

    test('suggests datasets from context.datasets alongside sources and views', async () => {
      const contextWithDatasets = {
        ...mockContext,
        views: [{ name: 'my_saved_view', query: 'FROM logs | LIMIT 10' }],
        datasets: [
          {
            name: 'my_dataset',
            data_source: 'prod_s3_logs',
            resource: 's3://logs-bucket/access/**/*.parquet',
          },
        ],
      };
      const expectedFromSources = visibleIndices;

      await fromExpectSuggestions(
        'from ',
        [...expectedFromSources, 'my_saved_view', 'my_dataset', ...subquerySuggestions],
        mockCallbacks,
        contextWithDatasets
      );

      const getSuggestions = async (query: string) => {
        const cursorPosition = query.length;
        const { command } = findAutocompleteAstPosition(query, cursorPosition);
        return autocomplete(query, command!, mockCallbacks, contextWithDatasets, cursorPosition);
      };
      const suggestions = await getSuggestions('FROM my_d');
      const datasetSuggestion = suggestions.find((suggestion) => suggestion.text === 'my_dataset');

      expect(datasetSuggestion).toBeDefined();
      expect(datasetSuggestion?.detail).toBe('Dataset');
    });
  });

  describe('... METADATA <fields>', () => {
    const metadataFieldsAndIndex = metadataFields.filter((field) => field !== '_index');

    test('on <// FROM something METADATA field1, /kbd>SPACE</kbd> without comma ",", suggests adding metadata', async () => {
      const recommendedQueries = getRecommendedQueriesTemplates({
        fromCommand: '',
        timeField: '@timestamp',
        categorizationField: 'keywordField',
      });
      const expected = [
        '\n',
        'METADATA ',
        ', ',
        '| ',
        ...recommendedQueries.map((query) => query.queryString),
      ].sort();

      await fromExpectSuggestions('from a, b ', expected, mockCallbacks);
    });

    test('partially-typed METADATA keyword', async () => {
      // The editor keeps only the items matching the word typed.
      await fromExpectSuggestions(
        'FROM index1 MET',
        ['METADATA ', ', ', '| ', '\n'],
        mockCallbacks
      );
    });

    test('not before first index', async () => {
      mockContext.sources = visibleDataSources;
      await fromExpectSuggestions(
        'FROM MET',
        [...visibleDataSources.map((source) => source.name), ...subquerySuggestions],
        mockCallbacks
      );
    });

    test('on <kbd>SPACE</kbd> after "METADATA" keyword suggests all metadata fields', async () => {
      await fromExpectSuggestions('from a, b METADATA ', metadataFields, mockCallbacks);
    });

    test('metadata field prefixes', async () => {
      await fromExpectSuggestions('from a, b METADATA _', metadataFields, mockCallbacks);
      await fromExpectSuggestions('from a, b METADATA _sour', metadataFields, mockCallbacks);
    });

    test('suggests CPS metadata fields only when serverless', async () => {
      await fromExpectSuggestions('from a, b METADATA _proj', metadataFields, mockCallbacks);
      await fromExpectSuggestions(
        'from a, b METADATA _proj',
        [...metadataFields, ...CPS_METADATA_FIELDS].sort(),
        { ...mockCallbacks, isServerless: true }
      );
    });

    test('on <kbd>SPACE</kbd> after "METADATA" column suggests command and pipe operators', async () => {
      await fromExpectSuggestions('from a, b metadata _index ', ['\n', ', ', '| '], mockCallbacks);
      await fromExpectSuggestions(
        'from a, b metadata _index, _source ',
        ['\n', ', ', '| '],
        mockCallbacks
      );
      await fromExpectSuggestions(
        `from a, b metadata ${METADATA_FIELDS.join(', ')} `,
        ['\n', '| '],
        mockCallbacks
      );
    });

    test('filters out already used metadata fields', async () => {
      await fromExpectSuggestions(
        'from a, b metadata _index, ',
        metadataFieldsAndIndex,
        mockCallbacks
      );
    });
  });

  describe('... (FROM <subquery>)', () => {
    const contextWithSubquery = {
      ...mockContext,
      isCursorInSubquery: true,
    };

    const recommendedQueries = getRecommendedQueriesTemplates({
      fromCommand: '',
      timeField: '@timestamp',
      categorizationField: 'keywordField',
    });

    const nextActionsWithMetadata = [
      '\n',
      'METADATA ',
      ', ',
      '| ',
      ...recommendedQueries.map((query) => query.queryString),
    ].sort();

    test('suggests subquery on space after FROM', async () => {
      await fromExpectSuggestions(
        'from /',
        [...visibleIndices, ...subquerySuggestions],
        mockCallbacks
      );
    });

    test('suggests subquery after comma', async () => {
      await fromExpectSuggestions(
        'from index, /',
        [...visibleIndices.filter((i) => i !== 'index'), ...subquerySuggestions],
        mockCallbacks
      );
    });

    test('suggests nested subqueries', async () => {
      await fromExpectSuggestions(
        'FROM a, (FROM /)',
        [...visibleIndices, ...subquerySuggestions],
        mockCallbacks,
        contextWithSubquery
      );
    });

    test('suggests pipe and comma after index in subquery', async () => {
      const query = 'FROM a, (FROM index )';
      const offset = query.lastIndexOf(')');

      await fromExpectSuggestions(
        query,
        nextActionsWithMetadata,
        mockCallbacks,
        contextWithSubquery,
        offset
      );
    });

    test('suggests METADATA keyword in subquery', async () => {
      const query = 'FROM a, (FROM index MET)';
      const offset = query.lastIndexOf(')');

      await fromExpectSuggestions(
        query,
        ['METADATA ', ', ', '| ', '\n'],
        mockCallbacks,
        contextWithSubquery,
        offset
      );
    });

    test('suggests pipe and comma after metadata field in subquery', async () => {
      const query = 'FROM a, (FROM index METADATA _id )';
      const offset = query.lastIndexOf(')');

      // As in the main query: no second METADATA, and no recommended queries after the fields.
      await fromExpectSuggestions(
        query,
        ['\n', ', ', '| '],
        mockCallbacks,
        contextWithSubquery,
        offset
      );
    });
  });

  describe('standalone (isStandalone) queries', () => {
    const standaloneExtensions = {
      recommendedQueries: [
        {
          name: 'Search all metrics',
          query: 'TS metrics-*',
          description: 'Searches all available metrics',
          isStandalone: true,
        },
        {
          name: 'Logs Count by Host',
          query: 'from logs* | STATS count(*) by host',
        },
      ],
      recommendedFields: [],
    };

    const contextWithStandalone = {
      ...mockContext,
      editorExtensions: standaloneExtensions,
    };

    const extensionSuggestions = getRecommendedQueriesTemplatesFromExtensions(
      standaloneExtensions.recommendedQueries
    );

    test('standalone suggestion appears after space alongside other suggestions', async () => {
      const recommendedQueries = getRecommendedQueriesTemplates({
        fromCommand: '',
        timeField: '@timestamp',
        categorizationField: 'keywordField',
      });
      const expected = [
        '\n',
        'METADATA ',
        ', ',
        '| ',
        ...recommendedQueries.map((query) => query.queryString),
        ...extensionSuggestions.map((s) => s.text),
      ].sort();

      await fromExpectSuggestions('from index ', expected, mockCallbacks, contextWithStandalone);
    });

    test('standalone suggestion has empty text, no rangeToReplace, and a command with queryText', async () => {
      const standaloneSuggestion = extensionSuggestions.find(
        (s) => s.label === 'Search all metrics'
      );

      expect(standaloneSuggestion).toBeDefined();
      expect(standaloneSuggestion!.text).toBe('');
      expect(standaloneSuggestion!.rangeToReplace).toBeUndefined();
      expect(standaloneSuggestion!.command).toEqual({
        id: 'esql.recommendedQuery.accept',
        title: 'Accept recommended query',
        arguments: [
          {
            queryLabel: 'Search all metrics',
            queryText: 'TS metrics-*',
          },
        ],
      });
    });

    test('non-standalone extension suggestions have non-empty text', async () => {
      const regularSuggestion = extensionSuggestions.find((s) => s.label === 'Logs Count by Host');

      expect(regularSuggestion).toBeDefined();
      expect(regularSuggestion!.text).not.toBe('');
    });
  });
});
