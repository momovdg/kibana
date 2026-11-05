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
 * the cursor would continue counts only after a dot, inside a dotted name like `a.b`; after
 * `ON x ` or a quoted name the name is done.
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
  const afterDot = previousTokenType === getTokenType('DOT');

  for (const slot of expectedRules) {
    if (slot.continuation && !afterDot) {
      continue;
    }

    const definition = isExpressionSlot(slot)
      ? fromRoles(slot)
      : bestMatch(command, slot) ?? fromRoles(slot) ?? bestMatch(defaults, slot);
    const filled = definition?.argument
      ? result.some((match) => match.definition.argument === definition.argument)
      : false;
    if (definition && !filled) {
      result.push({ slot, definition });
    }
  }

  return result;
};
