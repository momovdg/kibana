/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLCallbacks } from '@kbn/esql-types';
import type { ISuggestionItem } from '../../../commands/registry/types';
import type { ArgumentRole, EntityType } from '../../../esql_js_sim/definitions';

/**
 * What narrows the entities that apply at a place. Whoever lists entities gets a scope and
 * nothing else: no command, no query text.
 */
export interface EntityScope {
  /** Only sources of this index mode. */
  indexMode?: 'time_series';
  /** The place is inside a subquery. */
  inSubquery: boolean;
  /** For an entity that belongs to another: the name of that one, as the enrich policy. */
  parent?: string;
  /** For an inference endpoint: the task it must serve. */
  taskType?: string;
  /** The query runs on a serverless project. */
  isServerless: boolean;
}

/** An entity that can be named at a place. */
export interface EntityItem {
  name: string;
  /** What the entity is among its kind, as an index, an alias or a data stream for a source. */
  category?: string;
  /** Other names the same entity answers to. */
  aliases?: readonly string[];
  /** It exists and is not meant to be offered. */
  hidden?: boolean;
  /** The data type, for an entity that has one. */
  type?: string;
  /** What the entity is or holds, in a few words. */
  description?: string;
}

/** What the editor provides. Listing entities is the only thing the engine asks of it. */
export type EntityCallbacks = ESQLCallbacks;

/**
 * How the entities of one kind are listed. A definition returns data, never suggestions: how
 * an entity is shown is decided where suggestions are presented.
 */
export interface EntityDefinition {
  /** The entities that apply in a scope. */
  fetch: (callbacks: EntityCallbacks, scope: EntityScope) => Promise<EntityItem[]>;
  /**
   * Whether a name is one of the entities. Defaults to the name being among what `fetch`
   * returns; a source needs more, as a name may be a pattern or carry a selector.
   */
  exists?: (name: string, items: EntityItem[]) => boolean;
  /**
   * What the editor can do where an entity of this kind is expected, besides naming one: as
   * opening a browser of the sources. These are items of the editor, ready to show.
   */
  actions?: (
    callbacks: EntityCallbacks,
    scope: EntityScope,
    /** The name typed so far, when one is being typed. */
    typed?: string
  ) => Promise<ISuggestionItem[]>;
  /**
   * For an entity that defines what its value can be, as a setting does: the roles a value of
   * the named entity can have.
   */
  valueRoles?: (name: string) => ArgumentRole[];
}

/** One definition per kind of entity. A kind without a definition does not compile. */
export type EntityRegistry = Readonly<Record<EntityType, EntityDefinition>>;
