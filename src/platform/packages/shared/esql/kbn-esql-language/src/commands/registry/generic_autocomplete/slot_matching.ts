/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation, ExpectedRule } from '../../../language/shared/cursor_location/types';
import type { SlotDefinition } from './types';

/** Rules whose subtree is an expression, filled by the expression engine as a whole. */
const EXPRESSION_RULES = ['booleanExpression', 'primaryExpression'];

export const isExpressionSlot = ({ stack }: ExpectedRule): boolean =>
  stack.some((rule) => EXPRESSION_RULES.includes(rule));

/**
 * Tokens after which a slot that started earlier continues, rather than being done: a `:` after
 * an index's qualifier, as `_coordinator:` in LOOKUP JOIN.
 */
const CONTINUING_TOKENS = ['DOT', 'OPENING_BRACKET', 'COMMA', 'COLON'];

export interface SlotMatch {
  slot: ExpectedRule;
  definition: SlotDefinition;
}

const matches = ({ rule, parent, after }: SlotDefinition, slot: ExpectedRule): boolean =>
  rule === slot.rule &&
  (parent === undefined || parent === slot.stack[slot.stack.length - 1]) &&
  (after === undefined || after.some((name) => getTokenType(name) === slot.previousTokenType));

const bestMatch = (
  definitions: readonly SlotDefinition[],
  slot: ExpectedRule
): SlotDefinition | undefined => {
  let best: SlotDefinition | undefined;
  for (const definition of definitions) {
    if (matches(definition, slot) && (!best || specificity(definition) > specificity(best))) {
      best = definition;
    }
  }
  return best;
};

const specificity = ({ parent, after }: SlotDefinition): number =>
  (after ? 2 : 0) + (parent ? 1 : 0);

/**
 * The definition that fills each expected slot: the command's own, else the one the slot's
 * grammar roles give, else a default. Among definitions the most specific wins, and on a tie
 * the earlier one. Inside an expression only a role counts, as the column `DISSECT ` starts;
 * the expression engine fills the rest. Slots filling the same argument are filled once. A slot
 * the cursor would continue counts only inside it: after a dot in a dotted name like `a.b`, or
 * after `[` or a comma in a list like `["name", `. After `ON x ` or a quoted name the name is
 * done.
 */
export const matchSlots = (
  { expectedRules, previousTokenType }: CursorLocation,
  {
    command = [],
    fromRoles = () => undefined,
    defaults = [],
  }: {
    command?: readonly SlotDefinition[];
    fromRoles?: (slot: ExpectedRule) => SlotDefinition | undefined;
    defaults?: readonly SlotDefinition[];
  }
): SlotMatch[] => {
  const result: SlotMatch[] = [];
  const inside = CONTINUING_TOKENS.some((name) => getTokenType(name) === previousTokenType);

  for (const slot of expectedRules) {
    if (slot.continuation && !inside) {
      continue;
    }

    const definition = isExpressionSlot(slot)
      ? fromRoles(slot)
      : bestMatch(command, slot) ?? fromRoles(slot) ?? bestMatch(defaults, slot);
    // Calls of the same rule at one position, as both RENAME names at `RENAME `, are filled
    // once per argument, or once per definition when it does not name one.
    const filled = definition?.argument
      ? result.some((match) => match.definition.argument === definition.argument)
      : result.some(
          (match) =>
            match.definition === definition &&
            match.slot.rule === slot.rule &&
            match.slot.stack.join() === slot.stack.join()
        );
    if (definition && !filled) {
      result.push({ slot, definition });
    }
  }

  return result;
};
