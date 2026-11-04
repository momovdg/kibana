/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLAstAllCommands, ESQLSingleAstItem } from '@elastic/esql/types';
import type { CursorLocation, ExpectedRule } from '../../../language/shared/cursor_location/types';
import type { ExpressionContextOptions } from '../../definitions/utils/autocomplete/expressions/types';
import type { KeywordItem } from '../keyword_items';
import type { ICommandCallbacks, ICommandContext, ISuggestionItem, Location } from '../types';

/** What a provider can read to build its suggestions. */
export interface SuggestContext {
  query: string;
  command: ESQLAstAllCommands;
  cursorPosition: number;
  location: CursorLocation;
  callbacks?: ICommandCallbacks;
  context?: ICommandContext;
}

export type SlotProvider = (ctx: SuggestContext, slot: ExpectedRule) => Promise<ISuggestionItem[]>;

/** Fills an expected grammar rule (a slot) with suggestions. */
export interface SlotDefinition {
  /** The expected rule, e.g. `qualifiedNamePattern`. */
  rule: string;
  /** The rule directly above the slot, e.g. `enrichWithClause`. */
  parent?: string;
  /** Token names one of which comes directly before the slot or the word typed, e.g. `['AS']`. */
  after?: string[];
  /**
   * After a complete column typed in this slot, also offer what follows it, keeping the typed
   * column (`host, `, `host | `).
   */
  followUps?: boolean;
  provide: SlotProvider;
}

export interface ExpressionSpec {
  /** The `Location` the command passes to the expression engine, e.g. `Location.SORT`. */
  location: Location;
  options?: ExpressionContextOptions | ((ctx: SuggestContext) => ExpressionContextOptions);
  /** The expression at the cursor; by default the last argument that starts before it. */
  getRoot?: (ctx: SuggestContext) => ESQLSingleAstItem | undefined;
}

/** What a command declares instead of an `autocomplete` method. */
export interface CommandAutocompleteSpec {
  /** Command slots; they take precedence over the defaults with the same specificity. */
  slots?: SlotDefinition[];
  /** Narrows or adjusts the keyword and separator items the grammar allows. */
  keywords?: (keywords: KeywordItem[], ctx: SuggestContext) => KeywordItem[];
  /** Token names that, typed in full, get only what follows them (`asc` → `asc NULLS FIRST`). */
  keywordFollowUps?: string[];
  expression?: ExpressionSpec;
}
