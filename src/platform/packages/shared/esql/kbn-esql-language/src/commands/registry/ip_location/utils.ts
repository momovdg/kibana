/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isStringLiteral } from '@elastic/esql';
import type { ESQLAstIpLocationCommand } from '@elastic/esql/types';
import { Commands } from '../../definitions/keywords';
import { getColumnName, getCommandOutput } from '../../definitions/utils/columns';
import { getMapEntryByStringKeyFromAst } from '../../definitions/utils/maps';
import { matchesWildcardPattern } from '../../definitions/utils/regex';
import type { ElasticsearchCommandOutputVariant, SupportedDataType } from '../../definitions/types';

/**
 * When the query omits database_file, ES uses GeoLite2-City.mmdb.
 * The generated command definition stores those output columns under this wildcard variant.
 */
const IP_LOCATION_DEFAULT_OUTPUT_VARIANT = '*-City.mmdb';

/** Keeps only properties included by ES when the user does not pass properties. */
export const getDefaultPropertyNames = (variant: ElasticsearchCommandOutputVariant): string[] =>
  Object.entries(variant)
    .filter(([, metadata]) => metadata.default !== false)
    .map(([property]) => property);

/** Resolves a property type when no concrete database variant is available. */
export const getPropertyTypeFromAnyVariant = (property: string): SupportedDataType | undefined => {
  const output = getIpLocationOutputDefinition();

  if (!output) {
    return undefined;
  }

  for (const variant of Object.values(output.variants)) {
    const metadata = variant[property];
    if (metadata) {
      return metadata.type;
    }
  }

  return undefined;
};

/** Selects the output variant that controls which columns IP_LOCATION creates. */
export const getIpLocationVariant = (
  command: ESQLAstIpLocationCommand
): ElasticsearchCommandOutputVariant | undefined => {
  const output = getIpLocationOutputDefinition();

  if (!output) {
    return undefined;
  }

  const databaseFileEntry = getMapEntryByStringKeyFromAst(command.namedParameters, 'database_file');
  if (!databaseFileEntry) {
    return output.variants[IP_LOCATION_DEFAULT_OUTPUT_VARIANT];
  }

  const { value } = databaseFileEntry;
  if (!isStringLiteral(value)) {
    return undefined;
  }

  const normalizedDatabaseFile = value.valueUnquoted.toLowerCase();

  return Object.entries(output.variants).find(([pattern]) =>
    matchesWildcardPattern(pattern.toLowerCase(), normalizedDatabaseFile)
  )?.[1];
};

/** Converts the target field AST into the prefix used for generated column names. */
export const getIpLocationTargetPrefix = (
  command: ESQLAstIpLocationCommand
): string | undefined => {
  const { targetField } = command;

  if (!targetField) {
    return undefined;
  }

  return getColumnName(targetField);
};

/** Returns the generated output schema used to infer new columns. */
const getIpLocationOutputDefinition = () => getCommandOutput(Commands.IP_LOCATION);
