/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { isSource, isSubQuery } from '@elastic/esql';
import type { ESQLAstAllCommands } from '@elastic/esql/types';
import { buildSubqueryOpeners } from '../../language/autocomplete_v2/providers/subqueries';
import {
  getIndicesBrowserSuggestion,
  shouldSuggestIndicesBrowserAfterComma,
} from '../definitions/utils/autocomplete/resource_browser_suggestions';
import { withinQuotes } from '../definitions/utils/autocomplete/helpers';
import { endsWithWhitespace } from '../definitions/utils/regex';
import { getOverlapRange, isRestartingExpression } from '../definitions/utils/shared';
import {
  additionalSourcesSuggestions,
  buildDatasetsDefinitions,
  buildNamedSubqueriesDefinitions,
  buildViewsDefinitions,
  getSourceSuggestions,
  getSourcesFromCommands,
  specialIndicesToSuggestions,
} from '../definitions/utils/sources';
import { commaCompleteItem, newLineCompleteItem } from '../registry/complete_items';
import { getMetadataSuggestions } from '../registry/options/metadata';
import { getRecommendedQueriesSuggestions } from '../registry/options/recommended_queries';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem } from '../registry/types';
import type { SlotNode } from './types';

/*
 * A list of sources, for any command that takes one: the sources the editor knows (or only
 * the time series ones, where the role says so), the names the query binds, a subquery where
 * one can stand, and what the editor adds at that place: the browser of data sources and the
 * recommended queries. The rules are the ones the source commands shared already.
 */

interface SourcesInput {
  slot: SlotNode;
  query: string;
  cursorPosition: number;
  command: ESQLAstAllCommands;
  callbacks?: ICommandCallbacks;
  context?: ICommandContext;
  /** What the spec allows after the list: its keywords and the end of the command. */
  following: ISuggestionItem[];
}

const NO_EXTENSIONS = { recommendedFields: [], recommendedQueries: [] };
const INDEX = 'index';

export const provideSources = async ({
  slot,
  query,
  cursorPosition,
  command,
  callbacks,
  context,
  following,
}: SourcesInput): Promise<ISuggestionItem[]> => {
  const { role } = slot;

  if (role.kind !== 'entity') {
    return [];
  }

  const isTimeSeries = role.indexMode === 'time_series';
  const innerText = query.substring(0, cursorPosition);

  // A name in quotes that is still open is typed, not chosen.
  if (withinQuotes(innerText)) {
    return [];
  }

  const commandText = query.substring(command.location.min, cursorPosition);
  const browser = await getIndicesBrowserSuggestion({ callbacks, context });
  const indexes = getSourcesFromCommands([command], INDEX);
  const hasSources = command.args.some(
    (arg) => !Array.isArray(arg) && (isSource(arg) || isSubQuery(arg))
  );
  const bound = (context?.namedSubqueries ?? []).map(({ name }) => name);
  // A name the query binds stands in the place of the source of the same name.
  const visible = <T extends { name: string }>(items: T[] = []): T[] =>
    items.filter(({ name }) => !bound.includes(name));
  const sources = isTimeSeries
    ? (context?.timeSeriesSources ?? []).map(({ name }) => ({ name, hidden: false }))
    : visible(context?.sources);
  const subqueries =
    role.subqueries && !context?.isCursorInSubquery && commandText.length > command.name.length
      ? buildSubqueryOpeners(command.name)
      : [];
  // The ready-made queries of the editor; its own templates need the columns.
  const recommended = await getRecommendedQueriesSuggestions(
    context?.editorExtensions ?? NO_EXTENSIONS,
    isTimeSeries ? undefined : callbacks?.getByType
  );
  const replacement = { textBeforeCursor: innerText, commandStart: command.location.min };

  // Nothing is listed yet.
  if (!hasSources) {
    const first = isTimeSeries
      ? specialIndicesToSuggestions(context?.timeSeriesSources ?? [])
      : [
          ...buildNamedSubqueriesDefinitions(bound),
          ...getSourceSuggestions(sources, [], replacement),
          ...buildViewsDefinitions(visible(context?.views), []),
          ...buildDatasetsDefinitions(visible(context?.datasets), []),
          ...subqueries,
        ];

    return [...(browser ? [browser] : []), ...first];
  }
  // After a source: the list can go on, the command can, or a ready-made query takes over.
  if (endsWithWhitespace(commandText) && !isRestartingExpression(commandText)) {
    return [...following, commaCompleteItem, ...recommended];
  }

  // Another source, or the one being typed.
  const last = indexes.at(-1);
  const isTypingName = Boolean(last?.name && innerText.endsWith(last.name));
  const keyword = following.find(({ label }) => getOverlapRange(innerText, label));

  if (!isTypingName && keyword) {
    return [keyword];
  }

  const more = await additionalSourcesSuggestions(
    innerText,
    sources,
    indexes.map(({ name }) => name),
    recommended,
    isTimeSeries ? undefined : visible(context?.views),
    isTimeSeries ? undefined : visible(context?.datasets),
    !isTimeSeries && indexes.length === 1 && isTypingName ? replacement : undefined,
    isTimeSeries ? undefined : bound
  );

  return [
    ...(browser && shouldSuggestIndicesBrowserAfterComma(commandText) ? [browser] : []),
    // A name that is whole can end the line as it is.
    ...(isTypingName && last && !isTimeSeries
      ? [
          {
            ...newLineCompleteItem,
            text: `${last.name}\n`,
            filterText: last.name,
            rangeToReplace: { start: innerText.length - last.name.length, end: innerText.length },
          },
        ]
      : []),
    ...more,
    ...(isRestartingExpression(innerText) ? subqueries : []),
  ];
};

/** The fields a source command can ask for next to its columns, after their keyword. */
export const provideMetadataFields = ({
  query,
  cursorPosition,
  command,
  callbacks,
}: Pick<SourcesInput, 'query' | 'cursorPosition' | 'command' | 'callbacks'>): Promise<
  ISuggestionItem[]
> =>
  Promise.resolve(
    getMetadataSuggestions(
      command,
      query.substring(command.location.min, cursorPosition),
      callbacks?.isServerless
    )
  ).then((items) => items ?? []);
