/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { LicenseType } from '@kbn/licensing-types';
import { COMMAND_FACTS } from '../../../esql_js_sim/definitions';
import { getNesting } from '../pipeline';
import { getCommandAutocompleteDefinitions } from '../../../commands/registry/complete_items';
import type { ICommand } from '../../../commands/registry/registry';
import type { ISuggestionItem } from '../../../commands/registry/types';
import { ReplacementRangeStrategyKind } from '../../autocomplete/utils/prefix_range';
import { getRegisteredCommand } from '../command_metadata';
import type { SuggestionContext } from '../types';

/** Whether a registered command may be offered, by what its metadata asks for. */
const isAvailable = (
  { metadata }: ICommand,
  {
    hasLicense,
    activeProduct,
    precedingCommands,
    sourceIsTimeSeries,
    queryContainsSubqueries,
  }: SuggestionContext
): boolean => {
  const { license, observabilityTier, requiresTimeseriesSource, hiddenAfterCommands } = metadata;

  if (license && !hasLicense?.(license.toLocaleLowerCase() as LicenseType)) {
    return false;
  }

  const isOtherTier =
    observabilityTier !== undefined &&
    activeProduct?.type === 'observability' &&
    activeProduct.tier !== observabilityTier.toLocaleLowerCase();
  if (isOtherTier) {
    return false;
  }

  if (requiresTimeseriesSource && !sourceIsTimeSeries) {
    return false;
  }

  if (queryContainsSubqueries && metadata.hiddenWhenQueryContainsSubqueries) {
    return false;
  }

  return !hiddenAfterCommands?.some((name) =>
    precedingCommands.some((preceding) => preceding.name === name)
  );
};

/**
 * The names of the commands the grammar allows here, for the commands Kibana has registered
 * and may offer. A command the grammar has and Kibana has not adopted is left out.
 */
export const provideCommandNames = (
  commandRules: string[],
  context: SuggestionContext
): ISuggestionItem[] => {
  const nesting = getNesting(context.ir);
  const commands = new Set(
    commandRules
      .filter((rule) => !(COMMAND_FACTS[rule]?.notInItself && nesting.includes(rule)))
      .map(getRegisteredCommand)
      .filter((command): command is ICommand => command !== undefined)
      .filter((command) => isAvailable(command, context))
  );

  // A header statement comes before the query, so it does not start the query over.
  return [...commands].flatMap(({ name, metadata }) => {
    const items = getCommandAutocompleteDefinitions([name]);

    return metadata.type === 'header' ? items : items.map(startingQueryOver(context));
  });
};

/**
 * Where a query starts, what is chosen replaces the whole query, what is written after the
 * cursor included: a source or a ready-made query starts over.
 */
export const startingQueryOver =
  ({ ir: { position } }: SuggestionContext) =>
  (item: ISuggestionItem): ISuggestionItem =>
    position === 'start_of_query'
      ? { ...item, replacementRangeStrategy: { kind: ReplacementRangeStrategyKind.ROOT_QUERY } }
      : item;
