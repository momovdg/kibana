/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { suggestForEmptyExpression } from '../../../commands/definitions/utils/autocomplete/expressions/positions/empty_expression';
import { SuggestionBuilder } from '../../../commands/definitions/utils/autocomplete/expressions/suggestion_builder';
import type {
  ExpressionContext,
  SuggestForExpressionParams,
} from '../../../commands/definitions/utils/autocomplete/expressions/types';
import {
  comparisonFunctions,
  inOperators,
  logicalOperators,
  matchOperators,
  nullCheckOperators,
  patternMatchOperators,
} from '../../../commands/definitions/all_operators';
import {
  isArrayType,
  isParameterType,
  type FunctionParameterType,
  type SupportedDataType,
} from '../../../commands/definitions/types';
import { getFunctionDefinition } from '../../../commands/definitions/utils/functions';
import { getOperatorSuggestion } from '../../../commands/definitions/utils/operators';
import { getMatchingSignatures } from '../../../commands/definitions/utils/signatures/matchers';
import { commaWithAutoSuggestCompleteItem } from '../../../commands/registry/complete_items';
import { EXPRESSION_PARTS, FUNCTION_CALL } from '../../../esql_js_sim/definitions';
import type { ISuggestionItem } from '../../../commands/registry/types';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import {
  getOperandRange,
  isOperandOf,
  type ExpressionPosition,
  type FunctionCallPosition,
  type ExpressionPositionKind,
} from './expression_position';

/**
 * The positions this layer decides. The others still go to the expression engine of the
 * current flow, until each is moved here.
 */
export const DECIDED_KINDS = new Set<ExpressionPositionKind>([
  'empty',
  'after_operand',
  'after_operator',
]);

/** What a decision needs: the cursor in the grammar, and what the item builders take. */
export interface DecisionInput {
  ir: CursorIR;
  position: ExpressionPosition;
  /** The role and the editor, in the terms the item builders take. */
  request: SuggestForExpressionParams;
  /** The type of what is written of the expression. */
  expressionType: ExpressionType;
  /** The type of what is written between two offsets. */
  typeOf: (range: { start: number; end: number }) => ExpressionType;
  /**
   * What the definition of the function around the cursor says about the argument there, by
   * the types of the arguments written before it. Nothing for a function that is not known.
   */
  getParameter: (call: FunctionCallPosition, startsArgument: boolean) => FunctionParameter;
}

type FunctionParameter =
  | NonNullable<SuggestForExpressionParams['options']>['functionParameterContext']
  | null;

type ExpressionType = SupportedDataType | 'unknown';

// The grammar name of the bracket that opens the arguments of a function.
const OPENING_BRACKET = 'LP';

/** What the item builders read: the request, with what the grammar says comes next. */
const toBuilderContext = ({ ir, request }: DecisionInput): ExpressionContext => ({
  ...request,
  innerText: request.query.slice(0, request.cursorPosition),
  options: {
    ...request.options,
    isCursorFollowedByComma: ir.next?.class === 'separator',
    isCursorFollowedByParens: ir.next?.token === OPENING_BRACKET,
  },
});

/**
 * Where an operand starts and the expression is not inside a function call: the columns and
 * the functions of the types the role accepts. A boolean is usually built from operands of
 * other types, as `a > 1`, so a role that asks for a boolean takes any operand here.
 */
const decideOperandStart = async (input: DecisionInput): Promise<ISuggestionItem[]> => {
  const { options = {} } = input.request;
  const preferred = [options.preferredExpressionType ?? []].flat();
  const isStrict =
    preferred.length > 0 && !preferred.includes('boolean') && !preferred.includes('any');
  const types = (isStrict ? preferred : ['any']) as FunctionParameterType[];
  const builder = new SuggestionBuilder(toBuilderContext(input));

  if (options.suggestFields ?? true) {
    await builder.addFields({
      types,
      ignoredColumns: options.ignoredColumnsForEmptyExpression ?? [],
      addSpaceAfterField: options.addSpaceAfterFirstField ?? true,
    });
  }

  return builder.addFunctions({ types }).build();
};

/** The word typed spells a keyword the command expects, and not an operator. */
const isTypedKeyword = ({ word, followers }: CursorIR): boolean =>
  followers.some((follower) => follower.token === word?.keyword && follower.class === 'keyword');

const namesOf = (operators: Array<{ name: string }>): string[] => operators.map(({ name }) => name);

const STRING_TYPES: readonly string[] = ['text', 'keyword'];
// What tells of a string: whether it matches, is in a list, or is missing.
const STRING_PREDICATES = namesOf([
  ...matchOperators,
  ...patternMatchOperators,
  ...inOperators,
  ...nullCheckOperators,
]);
const NULL_CHECK_END = 'null';
const ASSIGNMENT = '=';

/**
 * The operators that can follow an operand of a type, by name; all of them when undefined,
 * none when empty. Every operator on a string gives a boolean, so a role that asks for
 * another type takes none after a string.
 */
const getOperatorsAfter = (type: string, preferred: readonly string[]): string[] | undefined => {
  if (!STRING_TYPES.includes(type)) {
    return undefined;
  }

  const takesBoolean = preferred.includes('boolean') || preferred.includes('any');

  if (!takesBoolean && preferred.length > 0) {
    return [];
  }

  return [...(takesBoolean ? namesOf(comparisonFunctions) : []), ...STRING_PREDICATES];
};

/**
 * After a complete operand that no operator is written with, outside a function call: the
 * operators that take an operand of its type on their left.
 */
const decideAfterOperand = (input: DecisionInput): ISuggestionItem[] | undefined => {
  const { position, request, expressionType } = input;
  const { options = {}, location } = request;
  const values = position.written.filter((item) => item.class === 'value' || item.kind === 'rule');
  const brackets = position.written.filter((item) => item.kind === 'token');
  const openers = brackets.filter((item) => item.class === 'opener').length;
  const closers = brackets.filter((item) => item.class === 'closer').length;

  // A list in brackets, as `(a, b)`, is not decided here yet.
  if (brackets.some((item) => item.class === 'separator')) {
    return undefined;
  }
  // A null check is a complete condition: only another condition can be joined to it.
  if (position.operator === NULL_CHECK_END) {
    return logicalOperators.map(getOperatorSuggestion);
  }
  // A null check that is not finished, as `a IS`, is not decided here yet.
  if (position.operator !== undefined) {
    return undefined;
  }
  // A keyword of the command typed in full ends the expression: nothing of it is offered.
  if (isTypedKeyword(input.ir)) {
    return [];
  }
  if (!isParameterType(expressionType)) {
    return [];
  }

  const builder = new SuggestionBuilder(toBuilderContext(input));
  const isLiteral = values.length === 1 && EXPRESSION_PARTS[values[0].id]?.part === 'literal';
  const preferred = [options.preferredExpressionType ?? []].flat();
  const allowed =
    isLiteral && expressionType === 'boolean'
      ? namesOf(
          logicalOperators.filter((operator) => operator.locationsAvailable.includes(location))
        )
      : getOperatorsAfter(expressionType, preferred);

  if (allowed?.length !== 0) {
    builder.addOperators({
      leftParamType: expressionType === 'param' ? undefined : expressionType,
      allowed,
      ignored: [ASSIGNMENT],
    });
  }
  // Inside brackets that may hold a list, as that of `IN`, the next value can follow.
  if (options.allowSubquery && openers > closers && input.ir.next?.class === 'closer') {
    builder.addSuggestions([commaWithAutoSuggestCompleteItem]);
  }

  return builder.build();
};

// The operators that have rules of their own, decided in a later step.
const WITH_OWN_RULES: readonly string[] = ['in', 'like', 'rlike', 'is', 'not', 'null', ':'];
const LOGICAL: readonly string[] = ['and', 'or'];
const UNTYPED: readonly string[] = ['unknown', 'unsupported'];
const MATCH = ':';

const isLiteralAlone = (written: Array<{ id: string }>): boolean =>
  written.length === 1 && EXPRESSION_PARTS[written[0].id]?.part === 'literal';

/** The types an operator takes on its right for a type on its left. */
const getRightTypes = (
  signatures: Array<{ params: Array<{ name: string; type: string }> }>,
  leftType: string
): FunctionParameterType[] =>
  signatures
    .filter(({ params }) => params.some(({ name, type }) => name === 'left' && type === leftType))
    .flatMap(({ params }) => (params[1] ? [params[1].type] : []))
    .filter((type) => !isArrayType(type)) as FunctionParameterType[];

/**
 * After an operator, outside a function call. While the operator lacks its right operand: the
 * columns, literals and functions of the types it takes there for the type on its left. Once
 * it has both: the operators that can follow what it gives.
 */
const decideAfterOperator = async (
  input: DecisionInput
): Promise<ISuggestionItem[] | undefined> => {
  const { ir, position, request, typeOf } = input;
  const { options = {}, location, cursorPosition } = request;
  const { lastOperator, written } = position;
  const name = lastOperator?.text.toLowerCase() ?? '';
  const definition = getFunctionDefinition(name);
  const index = lastOperator ? written.indexOf(lastOperator) : -1;
  const before = written[index - 1];

  // An operator typed as the word, one before its operand, and one with rules of its own
  // are not decided here yet.
  if (!lastOperator || !definition || !before || WITH_OWN_RULES.includes(name)) {
    return undefined;
  }

  // What follows the operator and is still its operand: a bracket that closes it is not.
  const after = written.slice(index + 1).filter(isOperandOf(lastOperator, before));
  const lastWritten = after.at(-1);
  const left = getOperandRange(lastOperator, before);
  const right = lastWritten
    ? getOperandRange(lastOperator, lastWritten)
    : ir.word && { start: ir.word.start, end: cursorPosition };
  const leftType = typeOf(left);
  const rightType = right ? typeOf(right) : 'unknown';
  const builder = new SuggestionBuilder(toBuilderContext(input));

  // The right operand is missing, or is a name that is still being typed.
  if (!right || rightType === 'unknown') {
    // A condition is joined to any operand: the next condition starts with one.
    const types =
      leftType === 'boolean' && LOGICAL.includes(name)
        ? (['any'] as FunctionParameterType[])
        : getRightTypes(definition.signatures, leftType);

    await builder.addFields({
      types,
      values: true,
      addSpaceAfterField: options.addSpaceAfterOperator ?? false,
      openSuggestions: options.openSuggestions ?? false,
    });

    return builder
      .addLiterals({
        types,
        includeDateLiterals: true,
        includeCompatibleLiterals: false,
        addComma: false,
        advanceCursorAndOpenSuggestions: options.openSuggestions ?? false,
      })
      .addFunctions({ types, addSpaceAfterFunction: options.addSpaceAfterOperator ?? false })
      .build();
  }

  const preferred = [options.preferredExpressionType ?? []].flat();
  const isLiteral = [written.slice(0, index), after].map((side) =>
    isLiteralAlone(side.filter((item) => item.kind === 'rule'))
  );
  const fits = getMatchingSignatures(definition.signatures, [leftType, rightType], isLiteral, true);

  // The operands do not fit the operator, as a string joined to a condition: an operator
  // that makes of the right operand what the role asks for.
  if (!fits.length) {
    const canConvert =
      preferred.length > 0 && !preferred.includes(rightType) && !UNTYPED.includes(rightType);

    return canConvert
      ? builder.addOperators({ leftParamType: rightType, returnTypes: preferred }).build()
      : [];
  }

  // What the operator gives; when its right operand is a function call, what the call gives.
  const call = lastWritten?.class === 'closer' && lastWritten.ancestors.at(-1);
  const result =
    call && call.id === FUNCTION_CALL ? typeOf(call) : typeOf({ ...left, end: right.end });
  const [first] = written;
  const isInBrackets = first.class === 'opener' && written.at(-1)?.class === 'closer';
  const allowed =
    result === 'boolean' && isInBrackets
      ? namesOf([...logicalOperators, ...nullCheckOperators])
      : getOperatorsAfter(result, preferred) ??
        (result === 'boolean'
          ? namesOf(
              logicalOperators.filter((operator) => operator.locationsAvailable.includes(location))
            )
          : undefined);

  if (allowed?.length !== 0) {
    builder.addOperators({
      leftParamType: UNTYPED.includes(result) ? 'any' : result,
      ignored: [ASSIGNMENT, MATCH],
      allowed,
    });
  }

  return builder.build();
};

/**
 * Where an argument of a function starts: what the definition of the function takes there.
 * The definition decides everything, so the items are those the current flow builds for a
 * parameter: its listed values, or the literals, columns and functions of its types.
 */
const decideArgumentStart = async (
  input: DecisionInput,
  call: FunctionCallPosition
): Promise<ISuggestionItem[]> => {
  const { ir } = input;
  const parameter = input.getParameter(call, ir.previous?.class === 'separator' && !ir.word);

  if (!parameter) {
    return [];
  }

  const context = toBuilderContext(input);

  return suggestForEmptyExpression({
    ...context,
    options: {
      ...context.options,
      functionParameterContext: parameter,
      parentFunctionNames: call.enclosing,
    },
  });
};

/**
 * The items for a position inside an expression, decided from the grammar position. Returns
 * nothing for a position this layer does not decide yet.
 */
export const decideExpression = async (
  input: DecisionInput
): Promise<ISuggestionItem[] | undefined> => {
  const { kind, call } = input.position;

  if (!DECIDED_KINDS.has(kind)) {
    return undefined;
  }
  if (call) {
    // The other positions inside a function call are not decided here yet.
    return kind === 'empty' ? decideArgumentStart(input, call) : undefined;
  }

  switch (kind) {
    case 'after_operand':
      return decideAfterOperand(input);
    case 'after_operator':
      return decideAfterOperator(input);
    default:
      return decideOperandStart(input);
  }
};
