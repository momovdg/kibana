/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { ARGUMENT_ROLES } from '../../esql_js_sim/definitions';
import { readOptionShell } from '../../esql_js_sim/grammar';
import {
  getSuggestedValuesByName,
  getOptionDetails,
} from '../../language/autocomplete_v2/presentation';
import {
  describePromqlPosition,
  toDetailedPosition,
} from '../../language/autocomplete_v2/promql/position';
import { withAutoSuggest } from '../definitions/utils/autocomplete/helpers';
import { positionHandlers } from '../definitions/utils/autocomplete/promql/query_positions/dispatcher';
import { buildVectorSuggestions } from '../definitions/utils/autocomplete/promql/query_positions/suggestion_helpers';
import { getDateLiterals } from '../definitions/utils/literals';
import { getPreGroupedAggregationName } from '../definitions/utils/promql';
import {
  assignCompletionItem,
  commaCompleteItem,
  getNewUserDefinedColumnSuggestion,
  newLineAndPipeCompleteItems,
} from '../registry/complete_items';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem } from '../registry/types';
import type { SlotNode } from './types';

/*
 * A command that ends with a text in another language: options written as `name=value`, an
 * optional name for the result, then the text. The options are read from the tokens; the text
 * is served by what knows its language. Which options exist, which exclude each other and
 * what each takes as a value is in the roles the slot points to.
 */

interface SublanguageInput {
  slot: SlotNode;
  query: string;
  cursorPosition: number;
  commandStart: number;
  callbacks?: ICommandCallbacks;
  context?: ICommandContext;
}

type Columns = NonNullable<ICommandContext['columns']>;

/** The suggestions inside the text, by its language. */
const provideText = (
  text: string,
  textAfter: string,
  shouldWrap: boolean,
  columns: Columns,
  context?: ICommandContext
): ISuggestionItem[] => {
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
      variables: context?.variables,
      supportsControls: context?.supportsControls ?? false,
    }) ?? []
  );
};

export const provideSublanguage = ({
  slot,
  query,
  cursorPosition,
  commandStart,
  callbacks,
  context,
}: SublanguageInput): ISuggestionItem[] => {
  const { role } = slot;
  const names = role.kind === 'sublanguage' && role.options && ARGUMENT_ROLES[role.options.names];
  const values = role.kind === 'sublanguage' && role.options && ARGUMENT_ROLES[role.options.values];

  if (role.kind !== 'sublanguage' || !role.options || !names || names.kind !== 'option_name') {
    return [];
  }

  const optionNames = Object.keys(names.options);
  const isOption = (word: string): boolean => optionNames.includes(word.toLowerCase());
  const before = query.slice(0, cursorPosition);
  const after = query.slice(cursorPosition);
  const shell = readOptionShell(query, cursorPosition, commandStart, optionNames);
  const columns: Columns = context?.columns ?? new Map();
  const last = shell.options.at(-1);
  const valueRole =
    last && values && values.kind === 'dependent_value'
      ? values.roles?.[last.name.text.toLowerCase()]
      : undefined;

  // The cursor is at the value of an option: what the option takes.
  if (last?.open && valueRole) {
    if (valueRole.kind === 'entity') {
      const listed = last.values.map(({ text }) => text);

      return (context?.timeSeriesSources ?? [])
        .filter(({ name }) => !listed.includes(name))
        .map(({ name }) => withAutoSuggest({ label: name, text: name, kind: 'Issue', detail: '' }));
    }
    if (valueRole.kind === 'constant' && valueRole.valueType === 'date') {
      return getDateLiterals();
    }

    const suggested =
      getSuggestedValuesByName()[role.options.values]?.[last.name.text.toLowerCase()] ?? [];

    return suggested.flatMap((value) => (typeof value === 'string' ? [] : [value]));
  }

  const body = shell.bodyStart === undefined ? '' : before.slice(shell.bodyStart);
  const isTypingFirstWord = shell.bodyTokens === 1 && !/\s$/.test(before) && !shell.wrapped;

  // The name of an option is written and its assignment is still to come.
  if (shell.bodyTokens === 1 && isOption(body.trim()) && !isTypingFirstWord) {
    return [assignCompletionItem];
  }
  // The bracket of the command around the text is closed: only the command can end.
  if (shell.textEnd !== undefined) {
    return newLineAndPipeCompleteItems;
  }
  // The text has started: its language provides.
  if (shell.bodyStart !== undefined && !isTypingFirstWord) {
    const text = before.slice(shell.textStart ?? shell.bodyStart, shell.textEnd).trimEnd();

    return provideText(
      text,
      after,
      shell.result !== undefined || getPreGroupedAggregationName(text) !== undefined,
      columns,
      context
    );
  }

  // Before the text: an option that is not used and excludes none that is, a name for the
  // result, or the text itself.
  const used = [
    ...shell.options.map(({ name }) => name.text.toLowerCase()),
    ...optionNames.filter((name) => new RegExp(`\\b${name}\\s*=`, 'i').test(after)),
  ];
  const isUsed = (name: string): boolean => used.includes(name);
  const details = getOptionDetails()[role.options.names] ?? {};
  const options = Object.entries(names.options)
    .filter(([name]) => !isUsed(name))
    .filter(
      ([name, { conflictsWith = [] }]) =>
        !conflictsWith.some(isUsed) &&
        !Object.entries(names.options).some(
          ([other, facts]) => isUsed(other) && facts.conflictsWith?.includes(name)
        )
    )
    .map(([name]) =>
      withAutoSuggest({
        label: name,
        text: `${name} = `,
        kind: 'Reference',
        detail: details[name] ?? '',
      })
    );
  // The value of the last option can go on as a list where its role lists things once.
  const separator =
    valueRole?.kind === 'entity' && valueRole.unique && !isTypingFirstWord
      ? [withAutoSuggest({ ...commaCompleteItem, text: ', ' })]
      : [];
  // What comes after the cursor is an option: the text does not start here.
  const [next] = after.trimStart().split(/[\s=]/, 1);
  const startsText = !next || !isOption(next);

  return [
    ...separator,
    ...options,
    ...(startsText
      ? [
          getNewUserDefinedColumnSuggestion(callbacks?.getSuggestedUserDefinedColumnName?.() || ''),
          ...provideText('', '', false, columns, context),
        ]
      : []),
  ];
};
