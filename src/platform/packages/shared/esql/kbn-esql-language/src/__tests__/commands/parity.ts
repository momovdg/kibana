/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Temporary parity harness for moving commands to the generic autocomplete (refactor plan,
 * PR 2b). It is deleted in PR 2z, once every command has moved.
 */
import type { ESQLCallbacks } from '@kbn/esql-types';
import { esqlCommandRegistry } from '../../commands/registry';
import type { ICommandContext, ISuggestionItem } from '../../commands/registry/types';
import { createGenericAutocomplete } from '../../commands/registry/generic_autocomplete/generic_autocomplete';
import type { CommandAutocomplete } from '../../commands/registry/generic_autocomplete/generic_autocomplete';
import type { CommandAutocompleteSpec } from '../../commands/registry/generic_autocomplete/types';
import { suggest as suggestQuery } from '../../language/autocomplete/autocomplete';
import { getTokenType } from '../../language/shared/cursor_location/cursor_location';
import { getEsqlLexerTokens } from '../../language/shared/lexer_scope';
import { createCustomCallbackMocks } from '../../language/autocomplete/__tests__/helpers';
import { getMockCallbacks, mockContext } from './context_fixtures';
import { suggest as suggestCommand } from './autocomplete';

export interface ParityDifference {
  /** The query up to the cursor. */
  textBeforeCursor: string;
  path: 'command' | 'suggest';
  legacy: string[];
  generic: string[];
  /** The difference remains after the editor's filtering. */
  shown: boolean;
}

export interface ParityReport {
  positions: number;
  differences: ParityDifference[];
}

/** The legacy and generic implementations, for `describe.each` over a command's tests. */
export const bothImplementations = (
  legacy: CommandAutocomplete,
  spec: CommandAutocompleteSpec
): Array<[string, CommandAutocomplete]> => [
  ['legacy', legacy],
  ['generic', createGenericAutocomplete(() => spec)],
];

const KEYWORD = /\b[A-Z][A-Z_]+\b/g;

/**
 * Variants of a query that the regexes tended to miss: lowercase keywords, one command per
 * line, commas without a space, comments between the words after the command, and
 * backtick-quoted columns.
 */
export const queryVariants = (
  query: string,
  { commandName, columns = [] }: { commandName: string; columns?: string[] }
): string[] => {
  const commandStart = query.toLowerCase().indexOf(commandName.toLowerCase());
  const head = query.slice(0, commandStart + commandName.length);
  const tail = query.slice(head.length);
  const quoted = columns.reduce(
    (text, column) => text.replace(new RegExp(`\\b${column}\\b`, 'g'), `\`${column}\``),
    query
  );

  return [
    ...new Set([
      query,
      query.replace(KEYWORD, (word) => word.toLowerCase()),
      query.replace(/ \| /g, '\n| '),
      query.replace(/, /g, ','),
      head + tail.replace(/ (?=\S)/g, ' /* c */ '),
      quoted,
    ]),
  ];
};

/** Whether the editor would still show `item`, filtering by the text in its range. */
const isShown = (
  textBeforeCursor: string,
  { rangeToReplace, filterText, label }: ISuggestionItem
) => {
  const start =
    rangeToReplace?.start ?? textBeforeCursor.length - /\w*$/.exec(textBeforeCursor)![0].length;
  const word = textBeforeCursor.slice(start).trim().toLowerCase();
  if (!word) {
    return true;
  }
  // Like the editor's fuzzy match: the first character matches, the rest in order.
  const candidate = (filterText ?? label).toLowerCase();
  let index = candidate.indexOf(word[0]);
  if (index !== 0) {
    return false;
  }
  for (const char of word.slice(1)) {
    index = candidate.indexOf(char, index + 1);
    if (index < 0) {
      return false;
    }
  }
  return true;
};

const render = (items: ISuggestionItem[]): string[] =>
  items
    .map(({ text, rangeToReplace }) => {
      const range = rangeToReplace ? `@${rangeToReplace.start}-${rangeToReplace.end}` : '';
      return `${text.replace(/\n/g, '\\n')}${range}`;
    })
    .sort();

const compare = (
  textBeforeCursor: string,
  path: ParityDifference['path'],
  legacyItems: ISuggestionItem[],
  genericItems: ISuggestionItem[]
): ParityDifference | undefined => {
  const legacy = render(legacyItems);
  const generic = render(genericItems);
  if (legacy.join('\n') === generic.join('\n')) {
    return undefined;
  }

  const shownLegacy = render(legacyItems.filter((item) => isShown(textBeforeCursor, item)));
  const shownGeneric = render(genericItems.filter((item) => isShown(textBeforeCursor, item)));
  return {
    textBeforeCursor,
    path,
    legacy,
    generic,
    shown: shownLegacy.join('\n') !== shownGeneric.join('\n'),
  };
};

/** The cursor offsets from the end of the command keyword to the pipe that ends the command. */
const offsetsAfterCommand = (query: string, commandName: string): number[] => {
  const start = query.toLowerCase().indexOf(commandName.toLowerCase()) + commandName.length;
  let depth = 0;
  let end = query.length;
  for (const token of getEsqlLexerTokens(query)) {
    if (token.start < start) {
      continue;
    }
    if (token.type === getTokenType('LP')) {
      depth++;
    } else if (token.type === getTokenType('RP')) {
      depth--;
    } else if (token.type === getTokenType('PIPE') && depth <= 0) {
      end = token.start;
      break;
    }
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
};

/**
 * Runs the legacy and the generic autocomplete through the command test helper, which attaches
 * replacement ranges, at every cursor offset after the command keyword.
 */
export const compareAtEveryOffset = async ({
  commandName,
  legacy,
  generic,
  queries,
  context = mockContext,
}: {
  commandName: string;
  legacy: CommandAutocomplete;
  /** Usually `createGenericAutocomplete(() => spec)`. */
  generic: CommandAutocomplete;
  queries: string[];
  context?: ICommandContext;
}): Promise<ParityReport> => {
  const report: ParityReport = { positions: 0, differences: [] };

  for (const query of queries) {
    for (const offset of offsetsAfterCommand(query, commandName)) {
      report.positions++;
      const run = (impl: CommandAutocomplete) =>
        suggestCommand(query, context, commandName, getMockCallbacks(), impl, offset);
      const [legacyItems, genericItems] = await Promise.all([run(legacy), run(generic)]);
      const difference = compare(query.slice(0, offset), 'command', legacyItems, genericItems);
      if (difference) {
        report.differences.push(difference);
      }
    }
  }

  return report;
};

/**
 * Runs the full `suggest()` at every cursor offset after the command keyword, once with the
 * command's `legacy` autocomplete registered and once with only `spec`.
 */
export const compareThroughSuggest = async ({
  commandName,
  legacy,
  spec,
  queries,
  callbacks = createCustomCallbackMocks(),
}: {
  commandName: string;
  legacy: CommandAutocomplete;
  spec: CommandAutocompleteSpec;
  queries: string[];
  callbacks?: ESQLCallbacks;
}): Promise<ParityReport> => {
  const command = esqlCommandRegistry.getCommandByName(commandName);
  if (!command) {
    throw new Error(`Unknown command ${commandName}`);
  }

  const { methods, autocompleteSpec } = command;
  const runWith = async (
    registered: Pick<typeof command, 'methods' | 'autocompleteSpec'>,
    query: string,
    offset: number
  ) => {
    command.methods = registered.methods;
    command.autocompleteSpec = registered.autocompleteSpec;
    try {
      return await suggestQuery(query, offset, callbacks);
    } finally {
      command.methods = methods;
      command.autocompleteSpec = autocompleteSpec;
    }
  };

  const report: ParityReport = { positions: 0, differences: [] };
  for (const query of queries) {
    for (const offset of offsetsAfterCommand(query, commandName)) {
      report.positions++;
      const legacyItems = await runWith(
        { methods: { ...methods, autocomplete: legacy } },
        query,
        offset
      );
      const genericItems = await runWith(
        { methods: { ...methods, autocomplete: undefined }, autocompleteSpec: spec },
        query,
        offset
      );
      const difference = compare(query.slice(0, offset), 'suggest', legacyItems, genericItems);
      if (difference) {
        report.differences.push(difference);
      }
    }
  }

  return report;
};

const shorten = (items: string[]) => {
  const text = items.join(' ') || '[]';
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
};

/** The report as text for a PR description: shown differences first, then the rest. */
export const formatParityReport = ({ positions, differences }: ParityReport): string => {
  const shown = differences.filter((difference) => difference.shown);
  const hidden = differences.filter((difference) => !difference.shown);
  const rows = (list: ParityDifference[]) =>
    list.map(
      ({ textBeforeCursor, path, legacy, generic }) =>
        `${JSON.stringify(textBeforeCursor)} (${path})\n    legacy:  ${shorten(
          legacy
        )}\n    generic: ${shorten(generic)}`
    );

  return [
    `positions=${positions} differences=${differences.length} shown=${shown.length}`,
    '--- shown after the editor filters',
    ...rows(shown),
    '--- hidden by the editor filter',
    ...rows(hidden),
  ].join('\n');
};
