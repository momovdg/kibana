/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { getSafeInsertText } from '../../../commands/definitions/utils/autocomplete/helpers';
import { withAutoSuggest } from '../../../commands/definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from '../../../commands/registry/types';
import {
  ENTITY_FACTS,
  resolveRole,
  type EntityRole,
  type EntityType,
  type ResolvedRole,
} from '../../../esql_js_sim/definitions';
import type { EntityItem, EntityScope } from '../entities/types';
import { describeAfterName } from '../after_name';
import { getRegisteredCommand } from '../command_metadata';
import { ENTITIES } from '../entities/registry';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import type { SuggestionContext } from '../types';
import { getQualifierDetail } from '../presentation';
import { pathOf, unquoted, writtenWithRole } from '../written';
import { buildSubqueryOpeners } from './subqueries';

/** How an entity of each kind looks in the list. */
const ENTITY_KINDS: Readonly<Record<EntityType, ISuggestionItem['kind']>> = {
  source: 'Issue',
  lookup_index: 'Issue',
  enrich_policy: 'Class',
  enrich_field: 'Variable',
  inference_endpoint: 'Reference',
  metadata_field: 'Variable',
  setting: 'Reference',
};

// A name with a dash or a wildcard needs no quoting in these places.
const NAMES_AS_TYPED: readonly EntityType[] = [
  'source',
  'lookup_index',
  'metadata_field',
  'setting',
];

/** What narrows the entities at the cursor: what the role says, and what is written. */
const toScope = (role: EntityRole, { ir, callbacks }: SuggestionContext): EntityScope => {
  const parent = role.dependsOn
    ? ir.written.find(({ id }) => id === role.dependsOn)?.text
    : undefined;

  return {
    indexMode: role.indexMode,
    inSubquery: ir.enclosingCommands.length > 0,
    parent: parent === undefined ? undefined : unquoted(parent),
    isServerless: callbacks?.isServerless ?? false,
  };
};

/**
 * What comes after the name when it is chosen. A list item gets nothing: a separator can
 * follow. A name that only one symbol can follow gets that symbol, as a setting gets its `=`.
 * Any other name gets a space.
 */
const suffixAfterName = ({ afterName }: SuggestionContext): string => {
  const { isValid, separatorFollows, only } = describeAfterName(afterName);

  if (!isValid || separatorFollows) {
    return '';
  }

  const isOnlySymbol =
    !afterName.arguments.length && only?.class === 'operator' && only.text !== undefined;

  return isOnlySymbol ? ` ${only.text} ` : ' ';
};

const toSuggestion = (
  name: string,
  { description, category }: EntityItem,
  entityType: EntityType,
  suffix: string,
  detail = category
): ISuggestionItem => {
  const text = NAMES_AS_TYPED.includes(entityType)
    ? name
    : getSafeInsertText(name, { dashSupported: true });
  const item: ISuggestionItem = {
    label: name,
    text: `${text}${suffix}`,
    kind: ENTITY_KINDS[entityType],
    detail: detail ?? description,
  };

  // A name reopens the suggestions: what follows it comes next, also in a list.
  return withAutoSuggest(item);
};

const QUALIFIER_JOINER = ':';
// Where a name starts or is being typed, a qualifier before it included.
const NAME_POSITIONS: readonly string[] = ['start_of_argument', 'inside_argument'];

/**
 * The words that can come before a name of this kind, when the word being typed starts one
 * of them. Each comes with what joins it to the name, the cursor where the name goes.
 */
const provideQualifiers = (
  entityType: EntityType,
  { ir: { word } }: SuggestionContext
): ISuggestionItem[] => {
  const typed = word?.text.toLowerCase();
  const { qualifiers = [] } = ENTITY_FACTS[entityType];

  return typed === undefined
    ? []
    : qualifiers
        .filter((qualifier) => qualifier.startsWith(typed))
        .map((qualifier) =>
          withAutoSuggest({
            label: qualifier,
            text: `${qualifier}${QUALIFIER_JOINER}$0`,
            asSnippet: true,
            kind: 'Reference',
            detail: getQualifierDetail(entityType),
          })
        );
};

/**
 * Whether the last thing written is a qualifier left behind, as in `_any: `: the name it
 * qualifies is missing. The parser reads no argument there, so the text is read.
 */
export const isQualifierAlone = ({ segment, word, previous }: CursorIR): boolean => {
  // While the cursor is still at the qualifier, the name can be typed right after it. A
  // qualifier is read as a value: after anything else there is none to look for.
  if (word !== undefined || previous?.class !== 'value') {
    return false;
  }

  const last = segment.text.trimEnd().split(/\s+/).at(-1)?.toLowerCase();

  return Object.values(ENTITY_FACTS).some(({ qualifiers = [] }) =>
    qualifiers.some((qualifier) => last === `${qualifier}${QUALIFIER_JOINER}`)
  );
};

/**
 * The names the query binds before the command at the cursor that stand for an entity of the
 * kind the role names, as the name a subquery is bound to stands for a source. Each says which
 * command bound it. A name bound by the statement the cursor is in is not bound yet.
 */
const getBoundEntities = (role: EntityRole, { ir }: SuggestionContext): EntityItem[] => {
  const { boundAs } = ENTITY_FACTS[role.entityType];

  // A source of a kind, as a time series, is not something a subquery is.
  if (boundAs === undefined || role.indexMode !== undefined) {
    return [];
  }

  return ir.commands
    .filter(({ end }) => end <= ir.segment.start)
    .flatMap(({ rule, arguments: written }) =>
      written
        .filter((argument) => {
          const bound = resolveRole(pathOf(argument))?.role;

          return bound?.kind === 'new_name' && bound.of === boundAs;
        })
        .map(({ text }) => ({
          name: text,
          category: getRegisteredCommand(rule)?.name.toUpperCase(),
        }))
    );
};

/**
 * The entities the role names, in the scope of the cursor: the names the query binds first,
 * each in the place of an entity of the same name, then what the editor lists.
 */
const listEntities = async (
  role: EntityRole,
  context: SuggestionContext
): Promise<EntityItem[]> => {
  const bound = getBoundEntities(role, context);
  const names = bound.map(({ name }) => name);
  const listed = await ENTITIES[role.entityType].fetch(
    context.callbacks ?? {},
    toScope(role, context)
  );

  return [...bound, ...listed.filter(({ name }) => !names.includes(name))];
};

/** Whether a name is one of the entities the role names, in the scope of the cursor. */
export const isEntity = async (
  name: string,
  role: EntityRole,
  context: SuggestionContext
): Promise<boolean> => {
  const { exists } = ENTITIES[role.entityType];
  const items = await listEntities(role, context);

  return exists ? exists(name, items) : items.some((item) => item.name === name);
};

/**
 * The names of the entities the role names, in the scope of the cursor: hidden ones left out,
 * as are the ones already listed where each is listed once. An alias comes next to its entity.
 */
export const provideEntityNames = async (
  role: EntityRole,
  resolved: ResolvedRole,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  const items = await listEntities(role, context);
  const used = role.unique ? writtenWithRole(context.ir.written, resolved.id) : [];
  const suffix = suffixAfterName(context);
  const visible = items.filter(({ hidden, name }) => !hidden && !used.includes(name));

  return [
    ...visible.map((item) => toSuggestion(item.name, item, role.entityType, suffix)),
    ...visible.flatMap((item) =>
      (item.aliases ?? [])
        .filter((alias) => !used.includes(alias))
        .map((alias) => toSuggestion(alias, item, role.entityType, suffix, 'Alias'))
    ),
  ];
};

/**
 * The entities the role names, in the scope of the cursor. Hidden ones are left out, as are
 * the ones already listed where each is listed once. An alias is offered next to its entity.
 */
export const provideEntities = async (
  role: EntityRole,
  resolved: ResolvedRole,
  context: SuggestionContext
): Promise<ISuggestionItem[]> => {
  // A word that starts a qualifier is one: the names come after it.
  const qualifiers = provideQualifiers(role.entityType, context);
  if (qualifiers.length) {
    return qualifiers;
  }

  const scope = toScope(role, context);
  const currentCommand = context.ir.command && getRegisteredCommand(context.ir.command)?.name;
  // What the editor can do where a name is expected. A qualifier typed before the name is
  // not part of it.
  const startsName = NAME_POSITIONS.includes(context.ir.position);
  const typed = context.ir.word?.text.split(QUALIFIER_JOINER).at(-1);
  const actions = startsName
    ? (await ENTITIES[role.entityType].actions?.(context.callbacks ?? {}, scope, typed)) ?? []
    : [];

  return [
    ...actions,
    // Where a subquery can stand for the entity: one per command a subquery can start with.
    ...(role.subqueries && !scope.inSubquery ? buildSubqueryOpeners(currentCommand) : []),
    ...(await provideEntityNames(role, resolved, context)),
  ];
};
