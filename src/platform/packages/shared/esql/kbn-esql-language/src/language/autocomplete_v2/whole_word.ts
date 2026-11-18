/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLCallbacks } from '@kbn/esql-types';
import type { ISuggestionItem } from '../../commands/registry/types';
import { resolveRole } from '../../esql_js_sim/definitions';
import type { CursorIR } from '../../esql_js_sim/grammar';
import { prepare, provideAll, type Located } from './collect';
import { isEntity } from './providers/entities';
import { startsLongerKeyword } from './providers/tokens';
import { isOfExpression } from './resolve';
import { pathOf, unquoted } from './written';

/*
 * What happens when the cursor is at the end of a word that is already whole, or in the
 * middle of a keyword of several words. Both ask the flow again about a text that is edited
 * at the cursor, and reshape what it offers there.
 */

const SEPARATOR_GAP = ' ';
// The words that are values and not names.
const LITERAL_WORDS: readonly string[] = ['true', 'false', 'null'];

/**
 * What can follow the word being typed when the word is already whole: the items the flow
 * offers one space later, each as the word with what follows it, so that one choice does
 * both. A column that exists and a keyword typed in full get every continuation of the
 * command; a complete value only the end of its statement.
 */
export const provideFollowUps = async (
  fullText: string,
  offset: number,
  { ir, context }: Located,
  callbacks?: ESQLCallbacks
): Promise<ISuggestionItem[] | undefined> => {
  const { word } = ir;

  if (!word?.complete || !context) {
    return undefined;
  }

  // A keyword typed in full is whole as a column that exists is.
  const isKeyword = word.keyword !== undefined;
  const isColumn =
    word.kind === 'name' && (await context.getColumnMap()).has(word.argument?.text ?? word.text);
  const isValue =
    !isKeyword &&
    (word.kind === 'number' ||
      word.kind === 'string' ||
      LITERAL_WORDS.includes(word.text.toLowerCase()));
  // A name is whole too when it is one of the entities expected there.
  const entity = ir.arguments
    .map(({ path, rule }) => resolveRole(path, rule)?.role)
    .find((role) => role?.kind === 'entity');
  // A name in quotes is one too: the quotes are how it is written, not part of it.
  const isEntityName =
    (word.kind === 'name' || word.kind === 'string') &&
    entity?.kind === 'entity' &&
    (await isEntity(unquoted(word.argument?.text ?? word.text), entity, context));

  if (!isKeyword && !isColumn && !isValue && !isEntityName) {
    return undefined;
  }

  const spaced = `${fullText.slice(0, offset)}${SEPARATOR_GAP}${fullText.slice(offset)}`;
  // One space later only what can follow in the command is asked for: no other item is built.
  const { continuations } = await provideAll(
    await prepare(spaced, offset + SEPARATOR_GAP.length, callbacks),
    { continuationsOnly: true }
  );
  const name = word.argument?.text ?? word.text;

  // A number can still go on, so only the end of its statement is offered with it. A string
  // is closed by its quote: everything that can follow it is.
  if (isValue && !isEntityName && word.kind !== 'string') {
    return continuations
      .filter(({ request }) => request.kind === 'token' && request.follower.class === 'terminator')
      .flatMap(({ items }) => items);
  }

  return continuations.flatMap(({ request, items }) =>
    items.map((item) => {
      // The next line and the end of a statement are offered as they are; a separator
      // follows the name with no gap.
      const isTerminator = request.kind === 'token' && request.follower.class === 'terminator';
      if (request.kind === 'end_of_command' || isTerminator) {
        return item;
      }

      const isSeparator = request.kind === 'token' && request.follower.class === 'separator';

      // The item replaces the word, so the editor matches it by the word and not by its label.
      return {
        ...item,
        text: `${name}${isSeparator ? '' : SEPARATOR_GAP}${item.text}`,
        filterText: name,
      };
    })
  );
};

/**
 * Where a keyword of several words starts when the cursor is in it, as in `NULLS F`. Its
 * first word alone says nothing, so the editor goes on as if the keyword was typed from its
 * start: it offers what it offered there, the whole keyword among it.
 */
export const getLongerKeywordStart = (
  { word, followers, written }: CursorIR,
  fullText: string,
  offset: number
): number | undefined => {
  // The first word is the word being typed, in full.
  const spelled = followers.find(
    (follower) => follower.class === 'keyword' && follower.token === word?.keyword
  );

  if (word && spelled) {
    return !spelled.startsCommand && !isOfExpression(spelled.path) && startsLongerKeyword(spelled)
      ? word.start
      : undefined;
  }

  // The first word is written, and the cursor is at its second word. The name of the command
  // is not such a word: what follows it is offered as the command's own.
  const last = written.at(-1);
  const isAtNextWord =
    written.length > 1 &&
    last?.kind === 'token' &&
    last.class === 'keyword' &&
    last.token !== undefined &&
    fullText.slice(last.end, word?.start ?? offset).trim() === '';

  return last?.token !== undefined &&
    isAtNextWord &&
    !isOfExpression(pathOf(last)) &&
    startsLongerKeyword({ id: last.id, token: last.token })
    ? last.start
    : undefined;
};
