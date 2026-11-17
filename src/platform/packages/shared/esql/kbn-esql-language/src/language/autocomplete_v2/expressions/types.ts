/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { CommaContext } from '../../../commands/definitions/utils/autocomplete/expressions/comma_decision_engine';
import type {
  PreferredExpressionType,
  SuggestForExpressionParams,
} from '../../../commands/definitions/utils/autocomplete/expressions/types';
import type { FunctionParameterType, SupportedDataType } from '../../../commands/definitions/types';
import type { ISuggestionItem, Location } from '../../../commands/registry/types';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import type { ExpressionPosition, FunctionCallPosition } from './position';

export type ExpressionType = SupportedDataType | 'unknown';

/** What the definition of a function says about one of its arguments. */
export type FunctionParameter = NonNullable<
  NonNullable<SuggestForExpressionParams['options']>['functionParameterContext']
>;

interface Range {
  start: number;
  end: number;
}

/** The types of what is written, and what the functions written take. */
export interface TypeLookup {
  /** The type of what is written of the expression. */
  expressionType: ExpressionType;
  /** The type of what is written between two offsets. */
  typeOf: (range: Range) => ExpressionType;
  /**
   * What the definition of the function that starts at an offset says about the argument at
   * the cursor, by the types of the arguments written before it. Nothing for a function that
   * is not known.
   */
  getParameter: (
    call: { start: number; name?: string },
    startsArgument: boolean
  ) => FunctionParameter | null;
}

/** What a rule reads to decide what is offered at a position inside an expression. */
export interface OfferInput extends TypeLookup {
  ir: CursorIR;
  position: ExpressionPosition;
  /** The types the role asks for; none when it takes any. */
  preferred: readonly string[];
  /** A subquery can stand where a list of values can. */
  allowsSubquery: boolean;
  /** Columns are read here, and not only as the arguments of a function. */
  readsColumns: boolean;
  /** The columns that are already an item of the list on their own, where each is listed once. */
  listedColumns: string[];
  /** The set of functions and operators that apply. */
  location: Location;
  /** The text before the cursor, and where the cursor is. */
  textBefore: string;
  offset: number;
}

/**
 * What is offered at a position inside an expression, as data: which operands, which
 * operators, whether the comma. A rule returns one and builds no item itself, except the
 * ones that are ready-made.
 */
export interface Offer {
  /** The function whose argument the offer is for, with what its definition says there. */
  call?: { position: FunctionCallPosition; parameter: FunctionParameter };
  /** Columns, literals and functions of some types. */
  operands?: {
    types?: FunctionParameterType[];
    columns: boolean;
    ignoredColumns?: string[];
    /** A space follows the column, and the suggestions open again. */
    spaced: boolean;
    /** The values of a column can be picked through a control. */
    values?: boolean;
    /** Literals of exactly the types, or also of the types that convert to them. */
    literals?: 'exact' | 'compatible';
  };
  /** The operators that can follow an operand. */
  operators?: {
    after?: FunctionParameterType;
    allowed?: string[];
    ignored?: string[];
    giving?: PreferredExpressionType[];
  };
  /** The comma that ends an argument of a function, when the facts given say it can. */
  comma?: CommaContext;
  /** The constants a parameter takes, and what is offered when it takes none. */
  constants?: {
    parameter: FunctionParameter;
    orElse?: Offer;
  };
  /**
   * Everything a helper of the editor offers for the position: what the definition of a
   * function lists for a parameter, or the suggestions of the query language of a string.
   */
  whole?: 'parameter' | 'string';
  /** Items that are ready-made. */
  items?: ISuggestionItem[];
}
