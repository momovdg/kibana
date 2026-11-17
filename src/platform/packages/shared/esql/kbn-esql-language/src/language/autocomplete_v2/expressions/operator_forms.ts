/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import {
  logicalOperators,
  nullCheckOperators,
  operatorsDefinitions,
} from '../../../commands/definitions/all_operators';
import type { FunctionParameterType } from '../../../commands/definitions/types';
import { getFunctionDefinition } from '../../../commands/definitions/utils/functions';
import { getOperatorSuggestion } from '../../../commands/definitions/utils/operators';
import {
  commaCompleteItem,
  commaWithAutoSuggestCompleteItem,
  likePatternItems,
  listCompleteItem,
  rlikePatternItems,
} from '../../../commands/registry/complete_items';
import type { ISuggestionItem } from '../../../commands/registry/types';
import type { CursorIR, WrittenArgument } from '../../../esql_js_sim/grammar';
import { buildSubqueryOpeners } from '../providers/subqueries';
import { isColumnPart, lowerTextOf } from '../written';
import { getOperandRange } from './position';
import type { Offer, OfferInput } from './types';

/*
 * The operators that are written in a form of their own: a null check of several words, a
 * negation before or after an operand, a pattern, a list in brackets. Each rule says what is
 * offered at the cursor inside the form.
 */

const NULL_CHECKS: readonly string[] = ['is null', 'is not null'];
const NOT_FOLLOWERS: readonly string[] = ['like', 'rlike', 'in'];

/** A condition is whole: another one can be joined to it. */
export const joinCondition = (): ISuggestionItem[] => logicalOperators.map(getOperatorSuggestion);

/**
 * A null check that is not finished, as `a IS` or `a IS NOT N`: the checks that what is typed
 * can still become.
 */
export const offerNullCheck = ({ ir, position }: OfferInput): Offer => {
  const start = position.written.findLastIndex((item) => lowerTextOf(item) === 'is');
  const typed = [
    ...position.written.slice(start).map(lowerTextOf),
    ir.word?.text.toLowerCase() ?? '',
  ]
    .join(' ')
    .trim();

  return {
    items: NULL_CHECKS.filter((name) => name.startsWith(typed)).flatMap((name) => {
      const definition = getFunctionDefinition(name);

      return definition
        ? [
            {
              label: name.toUpperCase(),
              text: name.toUpperCase(),
              kind: 'Operator' as const,
              detail: definition.description,
            },
          ]
        : [];
    }),
  };
};

/**
 * Right after `NOT`. Before an operand it negates a condition: the boolean columns and
 * functions. After an operand it starts `NOT IN`, `NOT LIKE` or `NOT RLIKE`.
 */
export const offerAfterNot = ({ position }: OfferInput, call?: Offer['call']): Offer => {
  const operands = position.written.filter((item) => item.class !== 'opener');
  const before = operands.at(-2);

  return before && before.class !== 'operator'
    ? {
        items: operatorsDefinitions
          .filter(({ name }) => NOT_FOLLOWERS.includes(name))
          .map(getOperatorSuggestion),
      }
    : { call, operands: { types: ['boolean'], columns: true, spaced: true } };
};

/** Whether a list in brackets is open after the operator, and what is written in it. */
const describeList = (after: WrittenArgument[], ir: CursorIR) => {
  const openers = after.filter((item) => item.class === 'opener').length;
  const closers = after.filter((item) => item.class === 'closer').length;
  const last = after.at(-1);

  return {
    isStarted: openers > 0,
    isClosed: openers > 0 && closers >= openers,
    // A bracket around the whole condition is closed after the list.
    isInClosedBrackets: closers > openers,
    // A value can start right after the bracket or a comma.
    startsValue: !ir.word && (last?.class === 'opener' || last?.class === 'separator'),
    values: after.filter((item) => item.kind === 'rule'),
  };
};

/**
 * After `LIKE` or `RLIKE`, as long as no pattern is written: example patterns, also as the
 * values of a list. Returns nothing once a pattern is written: the operator is then complete.
 */
export const offerLike = (
  { ir }: OfferInput,
  operator: string,
  after: WrittenArgument[]
): Offer | undefined => {
  const patterns = operator === 'rlike' ? rlikePatternItems : likePatternItems;
  const list = describeList(after, ir);

  if (!after.length && !ir.word) {
    return { items: patterns };
  }
  if (!list.isStarted) {
    return undefined;
  }
  if (list.isClosed) {
    return { items: joinCondition() };
  }

  return { items: list.startsValue ? patterns : [{ ...commaCompleteItem, text: ', ' }] };
};

/**
 * After `IN`: the bracket that opens its list, or a subquery where one may stand; inside the
 * list, the values of the type of the left operand that are not listed yet, or the comma
 * after a value; after the list, a condition can be joined.
 */
export const offerIn = (
  { ir, position, allowsSubquery, typeOf }: OfferInput,
  operator: WrittenArgument,
  after: WrittenArgument[]
): Offer => {
  const list = describeList(after, ir);

  if (!list.isStarted) {
    return { items: [listCompleteItem, ...(allowsSubquery ? buildSubqueryOpeners() : [])] };
  }
  // After the list a condition can be joined; one in brackets can also be checked for null.
  if (list.isClosed) {
    return {
      items: list.isInClosedBrackets
        ? [...logicalOperators, ...nullCheckOperators].map(getOperatorSuggestion)
        : joinCondition(),
    };
  }
  if (!list.startsValue) {
    return { items: [commaWithAutoSuggestCompleteItem] };
  }

  // The type of the values is that of the left operand when it is a column.
  const index = position.written.indexOf(operator);
  const leftItems = position.written
    .slice(0, index)
    .filter((item) => item.kind === 'rule' || item.class === 'value');
  const [left] = leftItems;
  const column = leftItems.length === 1 && isColumnPart(left) ? left : undefined;
  const type = column && typeOf(getOperandRange(operator, column));

  return {
    operands: {
      types: type ? ([type] as FunctionParameterType[]) : undefined,
      columns: true,
      ignoredColumns: list.values.length
        ? [
            ...(column ? [column.text] : []),
            ...list.values.filter(isColumnPart).map(({ text }) => text),
          ]
        : [],
      spaced: true,
      literals: 'compatible',
    },
  };
};
