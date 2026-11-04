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

const matches = (
  { rule, parent, after }: SlotDefinition,
  slot: ExpectedRule,
  previousTokenType: number | undefined
): boolean =>
  rule === slot.rule &&
  (parent === undefined || parent === slot.stack[slot.stack.length - 1]) &&
  (after === undefined || after.some((name) => getTokenType(name) === previousTokenType));

const specificity = ({ parent, after }: SlotDefinition): number =>
  (after ? 2 : 0) + (parent ? 1 : 0);

/**
 * The definition that fills each expected slot, outside expressions and continuations. The
 * most specific definition wins; on a tie, the earlier one, so command definitions go first.
 */
export const matchSlots = (
  { expectedRules, previousTokenType }: CursorLocation,
  definitions: readonly SlotDefinition[]
): SlotMatch[] => {
  const result: SlotMatch[] = [];

  for (const slot of expectedRules) {
    if (slot.continuation || isExpressionSlot(slot)) {
      continue;
    }

    let best: SlotDefinition | undefined;
    for (const definition of definitions) {
      if (
        matches(definition, slot, previousTokenType) &&
        (!best || specificity(definition) > specificity(best))
      ) {
        best = definition;
      }
    }

    if (best) {
      result.push({ slot, definition: best });
    }
  }

  return result;
};
