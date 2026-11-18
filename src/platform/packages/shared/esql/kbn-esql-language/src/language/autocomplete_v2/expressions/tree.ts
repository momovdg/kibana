/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Walker } from '@elastic/esql';
import type {
  ESQLAstAllCommands,
  ESQLAstQueryExpression,
  ESQLSingleAstItem,
} from '@elastic/esql/types';

/**
 * The node of the command for the expression that starts at `start`: the first one from there
 * on, and the widest of those that start together. Brackets around it belong to no node. With
 * an `end`, the widest that ends before it: the node of what is written between the two.
 *
 * The syntax tree is read only to ask for a type: the lookup of types works on its nodes.
 * Where the cursor is and what is written come from the grammar position.
 */
export const findExpressionRoot = (
  command: ESQLAstAllCommands | ESQLAstQueryExpression,
  start: number | undefined,
  end: number = Infinity
): ESQLSingleAstItem | undefined => {
  if (start === undefined) {
    return undefined;
  }

  const candidates = Walker.findAll(
    command,
    (node) =>
      node !== command &&
      node.location !== undefined &&
      node.location.min >= start &&
      node.location.max < end
  ) as ESQLSingleAstItem[];

  return candidates.reduce<ESQLSingleAstItem | undefined>((best, node) => {
    const { min, max } = node.location;
    const isBetter =
      !best || min < best.location.min || (min === best.location.min && max > best.location.max);

    return isBetter ? node : best;
  }, undefined);
};

const startsFrom = (item: unknown, offset: number): boolean => {
  const { location } = (item ?? {}) as { location?: { min: number } };

  return location !== undefined && location.min >= offset;
};

/**
 * A syntax tree without what starts at or after an offset: the text the locator adds after
 * the cursor so that the command parses is not something that is written.
 */
export const withoutTextFrom = <T>(value: T, offset: number): T => {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !startsFrom(item, offset))
      .map((item) => withoutTextFrom(item, offset)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, withoutTextFrom(child, offset)])
  ) as T;
};
