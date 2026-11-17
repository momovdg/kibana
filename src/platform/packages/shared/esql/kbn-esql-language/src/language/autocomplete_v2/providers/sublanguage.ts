/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { positionHandlers } from '../../../commands/definitions/utils/autocomplete/promql/query_positions/dispatcher';
import { buildVectorSuggestions } from '../../../commands/definitions/utils/autocomplete/promql/query_positions/suggestion_helpers';
import { getPreGroupedAggregationName } from '../../../commands/definitions/utils/promql';
import {
  assignCompletionItem,
  commaCompleteItem,
  getNewUserDefinedColumnSuggestion,
  newLineCompleteItem,
  pipeCompleteItem,
} from '../../../commands/registry/complete_items';
import type { ISuggestionItem } from '../../../commands/registry/types';
import { ARGUMENT_ROLES, type SublanguageRole } from '../../../esql_js_sim/definitions';
import type { WrittenArgument } from '../../../esql_js_sim/grammar';
import { getColumnsByTypeRetriever } from '../../shared/columns_retrieval_helpers';
import { getQueryForFields } from '../../shared/get_query_for_fields';
import { getAutocompleteCursorContext } from '../../shared/parse_for_autocomplete_query';
import type { ForeignBody } from '../option_shell';
import type { SuggestionContext } from '../types';
import { describePromqlPosition, toDetailedPosition } from './promql_position';
import { pickColumnName } from '../written';
import { provideOptionNames } from './structured';

type Columns = Awaited<ReturnType<SuggestionContext['getColumnMap']>>;

/** What a language written inside a command needs to offer its items. */
interface SublanguageInput {
  /** The text in that language before the cursor. */
  text: string;
  /** What is written after the cursor. */
  textAfter: string;
  /** The items are for a text in brackets, or for one that has to be put in brackets. */
  shouldWrap: boolean;
  columns: Columns;
  context: SuggestionContext;
}

type SublanguageProvider = (input: SublanguageInput) => ISuggestionItem[];

/**
 * One provider per language a command can hold a text in. Each reads the cursor from the
 * grammar of its language; the item builders are the ones that language already has.
 */
const SUBLANGUAGES: Readonly<Record<SublanguageRole['language'], SublanguageProvider>> = {
  promql: ({ text, textAfter, shouldWrap, columns, context: { callbacks } }) => {
    if (!text.trim()) {
      return buildVectorSuggestions(columns, [], shouldWrap);
    }

    const position = describePromqlPosition(text, text.length, textAfter);

    return (
      positionHandlers[position.kind]?.({
        position: toDetailedPosition(position),
        columns,
        shouldWrap,
        preGroupedAgg: getPreGroupedAggregationName(text),
        variables: callbacks?.getVariables?.(),
        supportsControls: callbacks?.canSuggestVariables?.() ?? false,
      }) ?? []
    );
  },
};

/**
 * The columns a command with a text in another language reads. They are not those of the
 * commands before it: the helper the commands share works them out from the command itself,
 * as from the sources one of its options names.
 */
const getOwnColumns = async ({ text, offset, callbacks }: SuggestionContext): Promise<Columns> => {
  const { root, astContext } = getAutocompleteCursorContext(text, offset);
  const innerText = text.slice(0, offset);
  const header = root.header?.filter(({ location }) => location.max < offset);

  return getColumnsByTypeRetriever(
    getQueryForFields(innerText, { ...astContext.astForContext, header }),
    innerText,
    callbacks
  ).getColumnMap();
};

/**
 * The items of a command that ends with a text in another language, where the cursor is not
 * at the value of an option: the options that can still be named, a name for the result, and
 * the items of the text, which its own language provides.
 */
export const provideSublanguage = async (
  { role, shell, written }: ForeignBody,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  const { text, offset, usedNames } = context;
  const before = text.slice(0, offset);
  const provideText = SUBLANGUAGES[role.language];
  const names = role.options && ARGUMENT_ROLES[role.options.names];
  const optionNames = names?.kind === 'option_name' ? Object.keys(names.options) : [];
  const isOption = (word: string): boolean => optionNames.includes(word.toLowerCase());
  const body = shell.bodyStart === undefined ? '' : before.slice(shell.bodyStart);
  const isTypingFirstWord = shell.bodyTokens === 1 && !/\s$/.test(before) && !shell.wrapped;

  // The name of an option is written and its assignment is still to come.
  if (shell.bodyTokens === 1 && isOption(body.trim()) && !isTypingFirstWord) {
    return [assignCompletionItem];
  }

  const columns = await getOwnColumns(context);

  // The bracket of the command around the text is closed: only the command can end.
  if (shell.textEnd !== undefined) {
    return [newLineCompleteItem, pipeCompleteItem];
  }

  // The text has started: its language provides.
  if (shell.bodyStart !== undefined && !isTypingFirstWord) {
    // The spaces before the cursor are not part of the text: its last token is where it is.
    const query = before.slice(shell.textStart ?? shell.bodyStart, shell.textEnd).trimEnd();

    return provideText({
      text: query,
      textAfter: text.slice(offset),
      shouldWrap: shell.result !== undefined || getPreGroupedAggregationName(query) !== undefined,
      columns,
      context,
    });
  }

  // An option written after the cursor is used too.
  const after = text.slice(offset);
  const writtenAfter = optionNames
    .filter((name) => new RegExp(`\\b${name}\\s*=`, 'i').test(after))
    .map(
      (name): WrittenArgument => ({
        id: role.options?.names ?? '',
        kind: 'rule',
        text: name,
        start: offset,
        end: offset,
        index: 0,
        ancestors: [],
        complete: true,
      })
    );

  // Before the text: an option, a name for the result, or the text itself.
  const options =
    names?.kind === 'option_name' && role.options
      ? provideOptionNames(
          names,
          { role: names, id: role.options.names, source: 'signature', enclosing: [] },
          { ...context, ir: { ...context.ir, written: [...written, ...writtenAfter] } }
        )
      : [];
  // The value of the last option can go on as a list when its role lists things once.
  const last = shell.options.at(-1);
  const values = role.options && ARGUMENT_ROLES[role.options.values];
  const lastRole =
    last && values?.kind === 'dependent_value'
      ? values.roles?.[last.name.text.toLowerCase()]
      : undefined;
  const separator =
    lastRole?.kind === 'entity' && lastRole.unique && !isTypingFirstWord ? [commaCompleteItem] : [];
  // What comes after the cursor is an option: the text does not start here.
  const [next] = text.slice(offset).trimStart().split(/[\s=]/, 1);
  const startsText = !next || !isOption(next);

  return [
    ...separator,
    ...options,
    ...(startsText
      ? [
          getNewUserDefinedColumnSuggestion(pickColumnName(usedNames)),
          ...provideText({ text: '', textAfter: '', shouldWrap: false, columns, context }),
        ]
      : []),
  ];
};
