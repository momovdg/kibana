/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  assignCompletionItem,
  buildSubqueryCompleteItems,
  commaCompleteItem,
  headerSemiColonCompleteItem,
  newLineCompleteItem,
  pipeCompleteItem,
} from '../../../commands/registry/complete_items';
import { withAutoSuggest } from '../../../commands/definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from '../../../commands/registry/types';
import {
  getCommandStarts,
  getTokenSuccessors,
  locate,
  type Follower,
} from '../../../esql_js_sim/grammar';
import { esqlCommandRegistry } from '../../../commands/registry';
import { SuggestionCategory } from '../../autocomplete/utils/sorting/types';
import type { SuggestionContext } from '../types';

const MAP_OPENER = '{';

const toKeywordItem = (label: string, text: string, asSnippet = false): ISuggestionItem =>
  withAutoSuggest({
    label,
    text,
    ...(asSnippet && { asSnippet }),
    kind: 'Reference',
    detail: label.charAt(0) + label.slice(1).toLowerCase(),
    category: SuggestionCategory.LANGUAGE_KEYWORD,
  });

/**
 * The items for a keyword, by what the grammar allows right after it:
 *
 * - nothing has to follow it (`ASC`): the keyword alone;
 * - only other keywords can (`NULLS`, then `FIRST` or `LAST`): the keywords together, as the
 *   first one alone says nothing;
 * - only a map can (`WITH`): the keyword with the braces of the map, the cursor inside;
 * - anything else has to follow (`BY`): the keyword and a space.
 */
const provideKeyword = ({ text = '', token, id }: Follower): ISuggestionItem[] => {
  const label = text.toUpperCase();
  // The rule that takes the token is the first part of the place: `rule>TOKEN` or `rule.label`.
  const [rule] = id?.split(/[.>]/) ?? [];
  const { tokens: next, canEnd } = rule
    ? getTokenSuccessors(rule, token)
    : { tokens: [], canEnd: false };

  if (canEnd) {
    return [toKeywordItem(label, label)];
  }
  if (next.length === 1 && next[0].text === MAP_OPENER) {
    return [toKeywordItem(label, `${label} ${MAP_OPENER} $0 }`, true)];
  }
  if (next.length > 0 && next.every((successor) => successor.class === 'keyword')) {
    return next.map((successor) => {
      const joined = `${label} ${successor.text?.toUpperCase()}`;
      const ends = getTokenSuccessors(rule, successor.token).canEnd;

      return toKeywordItem(joined, ends ? joined : `${joined} `);
    });
  }

  return [toKeywordItem(label, `${label} `)];
};

let commandStarts: Set<string> | undefined;

/** The tokens a command can start with, read from the grammar. */
const getStartTokens = (): Set<string> => {
  commandStarts ??= new Set(
    Object.values(getCommandStarts()).flatMap((starts) => starts.map(({ token }) => token))
  );

  return commandStarts;
};

/** The bracket opens a subquery: only the name of a command can follow it. */
export const opensSubquery = ({ class: tokenClass, token, id }: Follower): boolean => {
  const [rule] = id?.split(/[.>]/) ?? [];
  const next = tokenClass === 'opener' && rule ? getTokenSuccessors(rule, token).tokens : [];

  return next.length > 0 && next.every((successor) => getStartTokens().has(successor.token));
};

/**
 * The openings of a subquery, one per command a subquery can start with. When the subquery
 * ends its statement, as the one a name is bound to, the terminator comes with it.
 */
export const provideSubqueryOpener = ({
  text,
  offset,
  ir,
}: SuggestionContext): ISuggestionItem[] => {
  // A subquery inside a subquery is not offered.
  if (ir.enclosingCommands.length > 0) {
    return [];
  }

  const sources = esqlCommandRegistry
    .getAllCommands({ isStartingSubquery: true })
    .map(({ name }) => name);
  const [first] = sources;
  // What has to follow a whole subquery here: one is written and the grammar is asked.
  const closed = `${text.slice(0, offset)}(${first?.toUpperCase()} a) `;
  const after = first ? locate(closed, closed.length) : undefined;
  const [only] = after?.followers ?? [];
  const terminator =
    after?.followers.length === 1 && only.class === 'terminator' ? only.text ?? '' : '';

  return buildSubqueryCompleteItems({ previewCommands: sources }).map((item) => ({
    ...item,
    text: `${item.text}${terminator}`,
  }));
};

const ASSIGNMENT = '=';

/** The token assigns a value to the name before it, as in `name = value`. */
export const isAssignment = ({ class: tokenClass, text }: Follower): boolean =>
  tokenClass === 'operator' && text === ASSIGNMENT;

/**
 * The assignment after a name. A name that is an existing column is read as that column, so
 * only a name the query does not have yet can be assigned.
 */
export const provideAssignment = async ({
  ir,
  getColumnMap,
}: SuggestionContext): Promise<ISuggestionItem[]> => {
  const name = ir.written.at(-1);
  const isExisting =
    name?.kind === 'rule' && (await getColumnMap()).has(name.text.replace(/`/g, ''));

  return isExisting ? [] : [assignCompletionItem];
};

/** The item for a token with a fixed text, by the class of the token alone. */
export const provideToken = (follower: Follower): ISuggestionItem[] => {
  const { class: tokenClass, text = '' } = follower;

  switch (tokenClass) {
    case 'pipe':
      return [pipeCompleteItem];
    // A separator is followed by a space, so the next item of the list can be typed at once.
    case 'separator':
      return [withAutoSuggest({ ...commaCompleteItem, text: `${text} ` })];
    case 'keyword':
      return provideKeyword(follower);
    // The end of a header statement moves to the next line, where the next one starts.
    case 'terminator':
      return [headerSemiColonCompleteItem];
    // Operators, brackets and statement ends are offered with the arguments they belong to.
    default:
      return [];
  }
};

/** The item that ends the command by moving to the next line. */
export const provideEndOfCommand = (): ISuggestionItem[] => [newLineCompleteItem];
