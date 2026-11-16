/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  buildMapKeySuggestion,
  buildMapValueCompleteItem,
  type MapValueType,
} from '../../../commands/registry/complete_items';
import { withAutoSuggest } from '../../../commands/definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from '../../../commands/registry/types';
import {
  ARGUMENT_ROLES,
  resolveRole,
  type ArgumentRole,
  type DependentValueRole,
  type MapParameter,
  type MapRole,
  type OptionNameRole,
  type ResolvedRole,
} from '../../../esql_js_sim/definitions';
import type { ExpectedArgument, Follower } from '../../../esql_js_sim/grammar';
import { getCommandOutput } from '../../../commands/definitions/utils/columns';
import { matchesWildcardPattern } from '../../../commands/definitions/utils/regex';
import type { Commands } from '../../../commands/definitions/keywords';
import { getRegisteredCommand } from '../command_metadata';
import { getSuggestedParameterValues, OPENING_PARAMETERS } from '../presentation';
import { SuggestionCategory } from '../../autocomplete/utils/sorting/types';
import { ENTITIES } from '../entities/registry';
import type { SuggestionContext } from '../types';
import { MAP_OPENER, partOf, unquoted, pathOf, roleIdOf } from '../written';

const STRING_TYPES: readonly string[] = ['keyword', 'text', 'string'];
const NUMBER_TYPES: readonly string[] = ['integer', 'long', 'double', 'number'];

const LISTED_STRING = /"([^"]*)"/g;

const isString = ({ type }: MapParameter): boolean => STRING_TYPES.includes(type);

/** The text of the last written argument a call site took, without its quotes. */
const writtenAt = ({ ir }: SuggestionContext, id: string): string | undefined => {
  const written = ir.written.findLast((argument) => argument.id === id && !argument.open);

  return written && unquoted(written.text);
};

/**
 * How deep in maps a place is. A map inside a map repeats the call sites of a map entry in
 * the path, once per level, so the depth is how often the most repeated call site occurs.
 */
const mapDepth = (path: string[]): number =>
  Math.max(0, ...path.map((id) => path.filter((other) => other === id).length));

/** Whether a parameter applies, given the values the arguments it depends on have. */
const applies = ({ when = {} }: MapParameter, context: SuggestionContext): boolean =>
  Object.entries(when).every(([id, values]) => {
    const role = ARGUMENT_ROLES[id];
    const value = writtenAt(context, id) ?? (role?.kind === 'constant' ? role.default : undefined);

    return value !== undefined && values.includes(value.toLowerCase());
  });

const keyType = ({ type, list }: MapParameter): MapValueType => {
  if (list) {
    return 'array';
  }
  if (type === 'map') {
    return 'map';
  }
  if (type === 'boolean') {
    return 'boolean';
  }

  return NUMBER_TYPES.includes(type) ? 'number' : 'string';
};

/** The values a parameter can take: the ones it lists, the entities it names, or its default. */
const valuesOf = async (
  { values, entityType, taskType, default: defaultValue }: MapParameter,
  { callbacks }: SuggestionContext
): Promise<string[]> => {
  if (values) {
    return [...values];
  }
  if (entityType) {
    const entities = await ENTITIES[entityType].fetch(callbacks ?? {}, {
      taskType,
      inSubquery: false,
      isServerless: callbacks?.isServerless ?? false,
    });

    return entities.filter(({ hidden }) => !hidden).map(({ name }) => name);
  }

  return defaultValue === undefined ? [] : [defaultValue];
};

/**
 * The output columns a parameter selects from: the definition of a command's output says
 * which parameter selects them and which one tells the variants of the output apart. The
 * variant is the one the value written for that parameter matches, or its default.
 */
const selectableOutputs = (
  name: string,
  parameters: MapRole['parameters'],
  context: SuggestionContext
): string[] => {
  const { ir } = context;
  const command = ir.command === undefined ? undefined : getRegisteredCommand(ir.command);
  const output = command && getCommandOutput(command.name as Commands);

  if (!output || output.selected_by !== name) {
    return [];
  }

  const keys = ir.written.filter((written) => partOf(written) === 'map_key');
  const variantKey = keys.find(({ text }) => unquoted(text) === output.vary_by);
  const nextKey = variantKey && keys[keys.indexOf(variantKey) + 1];
  const written =
    variantKey &&
    ir.written.find(
      (value) =>
        partOf(value) === 'map_value' &&
        value.start > variantKey.start &&
        (!nextKey || value.start < nextKey.start)
    );
  const fallback = parameters[output.vary_by]?.default;
  const variantName = (written ? unquoted(written.text) : fallback)?.toLowerCase();
  const variant =
    variantName === undefined
      ? undefined
      : Object.entries(output.variants).find(([pattern]) =>
          matchesWildcardPattern(pattern.toLowerCase(), variantName)
        )?.[1];

  return Object.keys(variant ?? {});
};

/**
 * The keys of a map that are not used yet, or the values of the key before the cursor. The
 * parameters of a role describe the map itself, so nothing is offered inside a nested map.
 */
export const provideMap = async (
  { parameters }: MapRole,
  argument: ExpectedArgument,
  context: SuggestionContext,
  /** The name the map is the value of, when it is one, as the name of a setting. */
  owner?: string
): Promise<ISuggestionItem[]> => {
  if (mapDepth(argument.path) > 1) {
    return [];
  }

  const keys = context.ir.written.filter(
    (written) => partOf(written) === 'map_key' && mapDepth(pathOf(written)) === 1
  );

  if (partOf(argument) === 'map_key') {
    const used = keys.filter(({ open }) => !open).map(({ text }) => unquoted(text));

    return Object.entries(parameters)
      .filter(([name, parameter]) => !used.includes(name) && applies(parameter, context))
      .map(([name, parameter]) => buildMapKeySuggestion(name, keyType(parameter)));
  }

  const key = keys.at(-1);
  const parameter = key && parameters[unquoted(key.text)];

  if (!parameter || !applies(parameter, context)) {
    return [];
  }

  const name = unquoted(key.text);
  // The editor's own values for the parameter come first: they are items with a description.
  const suggested = owner === undefined ? undefined : getSuggestedParameterValues()[owner]?.[name];
  if (suggested) {
    return [...suggested];
  }

  const values = [
    ...(await valuesOf(parameter, context)),
    ...selectableOutputs(name, parameters, context),
  ];
  // In a list a value is given once: the ones written after the key are left out.
  const listed = parameter.list
    ? context.ir.written
        .filter((written) => partOf(written) === 'map_value' && written.start > key.start)
        // The grammar reads a list as one literal: its values are the strings in its text.
        .flatMap(({ text }) => [...text.matchAll(LISTED_STRING)].map(([, value]) => value))
    : [];

  return [...new Set(values)]
    .filter((value) => !listed.includes(value))
    .map((value) => buildMapValueCompleteItem(isString(parameter) ? `"${value}"` : value, value));
};

/** What stands for the value of a parameter in a ready-made map: its default when it has one. */
const valuePlaceholder = (parameter: MapParameter): string => {
  if (isString(parameter)) {
    return '"$0"';
  }

  return parameter.default === undefined ? '$0' : `\${0:${parameter.default}}`;
};

/**
 * The braces of a map where one has to be written, the cursor inside. A map that is written
 * for one parameter is opened with it: its only parameter, or the one the editor names.
 */
export const provideMapOpener = (
  { path }: Follower,
  { ir }: SuggestionContext
): ISuggestionItem[] => {
  const resolved = resolveRole(path);
  // Braces inside the map open the value of a parameter, which the role does not describe.
  const isInMap = ir.written.some(
    ({ text, ancestors }) => text === MAP_OPENER && ancestors.some(({ id }) => id === resolved?.id)
  );

  if (resolved?.role.kind !== 'map' || isInMap) {
    return [];
  }

  const { parameters } = resolved.role;
  const names = Object.keys(parameters);
  const opening =
    (resolved.id === undefined ? undefined : OPENING_PARAMETERS[resolved.id]) ??
    (names.length === 1 ? names[0] : undefined);
  const content = opening ? `"${opening}": ${valuePlaceholder(parameters[opening])}` : '$0';

  return [
    withAutoSuggest({
      label: opening ? `{ "${opening}": }` : '{ }',
      text: `{ ${content} }`,
      asSnippet: true,
      kind: 'Value',
      category: SuggestionCategory.CONSTANT_VALUE,
    }),
  ];
};

/**
 * The options that can still be named: not used yet, and not in conflict with one that is.
 * An option is chosen with its assignment.
 */
export const provideOptionNames = (
  { options }: OptionNameRole,
  resolved: ResolvedRole,
  context: SuggestionContext
): ISuggestionItem[] => {
  const used = context.ir.written
    .filter((written) => !written.open && roleIdOf(written) === resolved.id)
    .map(({ text }) => unquoted(text).toLowerCase());
  const isUsed = (name: string) => used.includes(name.toLowerCase());

  return Object.entries(options)
    .filter(([name]) => !isUsed(name))
    .filter(
      ([name, { conflictsWith = [] }]) =>
        !conflictsWith.some(isUsed) &&
        !Object.entries(options).some(
          ([other, facts]) => isUsed(other) && facts.conflictsWith?.includes(name)
        )
    )
    .map(([name]) =>
      withAutoSuggest({
        label: name,
        text: `${name} = `,
        kind: 'Reference',
        category: SuggestionCategory.LANGUAGE_KEYWORD,
      })
    );
};

/** The name a value depends on, as it is written. */
export const dependentName = (
  { on }: DependentValueRole,
  context: SuggestionContext
): string | undefined => writtenAt(context, on);

/**
 * The roles a value can have, given the name another argument gives: the role listed for
 * that name, or the roles the named entity defines for its value.
 */
export const dependentRoles = (
  { on, roles, definedBy }: DependentValueRole,
  context: SuggestionContext
): ArgumentRole[] => {
  const name = writtenAt(context, on);

  if (name === undefined) {
    return [];
  }

  const listed = roles?.[name] ?? roles?.[name.toLowerCase()];

  return [
    ...(listed ? [listed] : []),
    ...(definedBy ? ENTITIES[definedBy].valueRoles?.(name) ?? [] : []),
  ];
};
