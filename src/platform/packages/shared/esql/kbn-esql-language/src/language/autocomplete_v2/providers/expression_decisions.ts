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
  FunctionDefinitionTypes,
  isArrayType,
  isNumericType,
  isParameterType,
  type FunctionParameterType,
  type SupportedDataType,
} from '../../../commands/definitions/types';
import { shouldSuggestOperators } from '../../../commands/definitions/utils/autocomplete/expressions/positions/after_complete/should_suggest_operators';
import { getKqlSuggestionsIfApplicable } from '../../../commands/definitions/utils/autocomplete/expressions/utils';
import { getCommandMapExpressionSuggestions } from '../../../commands/definitions/utils/autocomplete/map_expression';
import { getFunctionDefinition } from '../../../commands/definitions/utils/functions';
import { parseMapParams } from '../../../commands/definitions/utils/maps';
import { getTimeUnitLiterals } from '../../../commands/definitions/utils/literals';
import {
  canAcceptMoreArgs,
  doesParamAcceptType,
  extractSignatureMapParams,
  isAmbiguousPosition,
  isTypeAcceptedAtPosition,
} from '../../../commands/definitions/utils/signatures/signature_analyzer';
import {
  hasArbitraryExpressionSignature,
  hasVariadicSignature,
} from '../../../commands/definitions/utils/signatures/traits';
import { getOperatorSuggestion } from '../../../commands/definitions/utils/operators';
import { getMatchingSignatures } from '../../../commands/definitions/utils/signatures/matchers';
import {
  buildMapValueCompleteItem,
  commaCompleteItem,
  commaWithAutoSuggestCompleteItem,
} from '../../../commands/registry/complete_items';
import { EXPRESSION_PARTS, FUNCTION_CALL } from '../../../esql_js_sim/definitions';
import type { ISuggestionItem } from '../../../commands/registry/types';
import type { CursorIR, WrittenArgument } from '../../../esql_js_sim/grammar';
import {
  decideAfterNot,
  decideIn,
  decideLike,
  decideNullCheck,
} from './expression_special_operators';
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
  'after_not',
  'in_string',
  'in_map',
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
  getParameter: (
    call: { start: number; name?: string },
    startsArgument: boolean
  ) => FunctionParameter;
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

/** The same, for a position inside the call of a function: with what its definition says. */
const toCallContext = (
  input: DecisionInput,
  call: FunctionCallPosition,
  parameter: NonNullable<FunctionParameter>
): ExpressionContext => {
  const context = toBuilderContext(input);

  return {
    ...context,
    options: {
      ...context.options,
      functionParameterContext: parameter,
      parentFunctionNames: call.enclosing,
    },
  };
};

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

/** A comma of the expression itself, and not one between the arguments of a call in it. */
const isOwnSeparator = (item: WrittenArgument): boolean =>
  item.class === 'separator' && item.ancestors.at(-1)?.id !== FUNCTION_CALL;

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
  if (brackets.some(isOwnSeparator)) {
    return undefined;
  }
  // A null check is a complete condition: only another condition can be joined to it.
  if (position.operator === NULL_CHECK_END) {
    return logicalOperators.map(getOperatorSuggestion);
  }
  // A null check that is not finished, as `a IS`.
  if (position.operator !== undefined) {
    return decideNullCheck({ ...input, context: toBuilderContext(input) });
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
const WITH_OWN_RULES: readonly string[] = ['is', 'null'];
const PATTERN_OPERATORS: readonly string[] = ['like', 'rlike'];
const LIST_OPERATOR = 'in';
const NEGATION = 'not';
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

/** The type of a range, or of the function call that ends it: a call gives its own type. */
const getResultType = (
  typeOf: DecisionInput['typeOf'],
  range: { start: number; end: number },
  last: WrittenArgument | undefined
): ExpressionType => {
  const closedCall = last?.class === 'closer' && last.ancestors.at(-1);

  return closedCall && closedCall.id === FUNCTION_CALL ? typeOf(closedCall) : typeOf(range);
};

/**
 * The operators that can follow what an operator gives, and inside a function call the comma
 * when that can be the whole argument.
 */
const offerAfterResult = (
  input: DecisionInput,
  result: ExpressionType,
  { parameter, context }: { parameter?: FunctionParameter; context: ExpressionContext }
): ISuggestionItem[] => {
  const { written } = input.position;
  const { options = {}, location } = input.request;
  const preferred = [options.preferredExpressionType ?? []].flat();
  const builder = new SuggestionBuilder(context);
  const [first] = written;
  const isInBrackets = first.class === 'opener' && written.at(-1)?.class === 'closer';
  const ownRule = parameter
    ? shouldSuggestOperators({
        expressionType: result,
        functionParameterContext: parameter,
        ctx: context,
      })
    : undefined;
  const allowedByType =
    result === 'boolean' && isInBrackets && !parameter
      ? namesOf([...logicalOperators, ...nullCheckOperators])
      : ownRule
      ? ownRule.allowedOperators
      : getOperatorsAfter(result, preferred);
  const allowed =
    allowedByType ??
    (result === 'boolean'
      ? namesOf(
          logicalOperators.filter((operator) => operator.locationsAvailable.includes(location))
        )
      : undefined);

  if ((ownRule?.shouldSuggest ?? true) && allowed?.length !== 0) {
    builder.addOperators({
      leftParamType: UNTYPED.includes(result) ? 'any' : result,
      ignored: [ASSIGNMENT, MATCH],
      allowed,
    });
  }
  // The result can be a whole argument: the next one can follow.
  if (parameter) {
    builder.addCommaIfNeeded({
      position: 'after_complete',
      typeMatches: doesParamAcceptType(parameter, result, false),
      isLiteral: false,
      hasMoreParams: canAcceptMoreArgs(parameter),
      isVariadic: hasVariadicSignature(parameter.signatures),
      hasMoreMandatoryArgs: parameter.hasMoreMandatoryArgs,
      isExpressionHeavy: hasArbitraryExpressionSignature(
        parameter.functionDefinition?.signatures ?? []
      ),
      isCursorFollowedByComma: false,
    });
  }

  return builder.build();
};

/**
 * After an operator, outside a function call. While the operator lacks its right operand: the
 * columns, literals and functions of the types it takes there for the type on its left. Once
 * it has both: the operators that can follow what it gives.
 */
const decideAfterOperator = async (
  input: DecisionInput,
  call?: FunctionCallPosition
): Promise<ISuggestionItem[] | undefined> => {
  const { ir, position, request, typeOf } = input;
  const { options = {}, cursorPosition } = request;
  const { lastOperator, written } = position;
  // An operator typed in full is the word, as `AND` in `a AND`: nothing is written after it.
  const typedOperator = lastOperator ? undefined : ir.word?.keyword && ir.word.text.toLowerCase();
  const name = lastOperator?.text.toLowerCase() ?? typedOperator ?? '';
  const index = lastOperator ? written.indexOf(lastOperator) : written.length;
  // `NOT` right before the operator is part of it, as in `a NOT LIKE b`.
  const isNegated = written[index - 1]?.text.toLowerCase() === NEGATION && name !== NEGATION;
  const before = written[index - (isNegated ? 2 : 1)];
  const definition = getFunctionDefinition(isNegated ? `${NEGATION} ${name}` : name);
  const following = written.slice(index + 1);

  const hasOwnRule = name === LIST_OPERATOR || PATTERN_OPERATORS.includes(name);

  // A null check has its own rule. Inside a call, so have the operators that take a list or
  // a pattern: those are not decided here yet.
  if (!definition || WITH_OWN_RULES.includes(name) || (call && hasOwnRule)) {
    return undefined;
  }

  // Inside a call, the definition of the function says what its argument may be.
  const parameter = call && input.getParameter(call, false);

  if (call && !parameter) {
    return [];
  }

  const context =
    call && parameter ? toCallContext(input, call, parameter) : toBuilderContext(input);

  // An operator before its operand, as `NOT a`: what follows is by what the operand gives.
  if (!before) {
    const [first] = following;
    const last = following.at(-1);

    return first && last
      ? offerAfterResult(
          input,
          getResultType(typeOf, { start: first.start, end: last.end }, last),
          {
            parameter,
            context,
          }
        )
      : undefined;
  }

  // What follows the operator and is still its operand: a bracket that closes it is not.
  const after = lastOperator ? following.filter(isOperandOf(lastOperator, before)) : [];
  const lastWritten = after.at(-1);

  // The operators that take a list or a pattern have rules of their own, outside a call.
  if (lastOperator && hasOwnRule) {
    const rule = { ...input, context };
    const own =
      name === LIST_OPERATOR
        ? await decideIn(rule, lastOperator, following)
        : decideLike(rule, name, following);

    if (own) {
      return own;
    }
  }

  // The left operand: what the operator applies to, or all that is written before a typed one.
  const left = lastOperator
    ? getOperandRange(lastOperator, before)
    : { start: position.start ?? before.start, end: before.end };
  const right = lastWritten
    ? getOperandRange(lastOperator ?? lastWritten, lastWritten)
    : lastOperator && ir.word && { start: ir.word.start, end: cursorPosition };
  const leftType = typeOf(left);
  const rightType = right ? typeOf(right) : 'unknown';
  const builder = new SuggestionBuilder(context);

  // The match operator takes a constant of the type its left operand asks for.
  if (name === MATCH && !right) {
    const matched = input.getParameter({ start: left.start, name }, true);
    const constants = matched
      ? new SuggestionBuilder(context)
          .addConstants({
            paramDefinitions: matched.paramDefinitions,
            shouldAddComma: false,
            hasMoreMandatoryArgs: matched.hasMoreMandatoryArgs,
            preferredPlaceholderType: matched.firstArgumentType,
            includeValuesControl: true,
            includeConstantFunctions: false,
          })
          .build()
      : [];

    if (constants.length) {
      return constants;
    }
  }

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
  return offerAfterResult(input, getResultType(typeOf, { ...left, end: right.end }, lastWritten), {
    parameter,
    context,
  });
};

const TIME_TYPES: readonly string[] = ['time_duration', 'date_period'];

/**
 * After a complete operand inside a function call: the unit of a time span after its number,
 * or the operators the function lets its argument go on with, and the comma when the operand
 * can be the whole argument.
 */
const decideAfterOperandInCall = (
  input: DecisionInput,
  call: FunctionCallPosition
): ISuggestionItem[] | undefined => {
  const { position, request, typeOf, ir } = input;
  const brackets = position.written.filter((item) => item.kind === 'token');
  const last = position.written.at(-1);

  // A list in brackets and a null check that is not finished are not decided here yet.
  if (
    !last ||
    position.start === undefined ||
    brackets.some(isOwnSeparator) ||
    (position.operator !== undefined && position.operator !== NULL_CHECK_END)
  ) {
    return undefined;
  }

  const parameter = input.getParameter(call, false);

  if (!parameter) {
    return [];
  }

  const isFollowedByComma = ir.next?.class === 'separator';

  // A null check is a complete condition: another one can be joined, or the argument ends.
  if (position.operator === NULL_CHECK_END) {
    const canEnd =
      !isFollowedByComma && (isAmbiguousPosition(parameter) || canAcceptMoreArgs(parameter));

    return [...logicalOperators.map(getOperatorSuggestion), ...(canEnd ? [commaCompleteItem] : [])];
  }

  const type = typeOf({ start: position.start, end: last.end });

  if (type === 'unknown') {
    return [];
  }

  const isLiteral = isLiteralAlone(position.written.filter((item) => item.kind === 'rule'));
  const { hasMoreMandatoryArgs, functionDefinition, paramDefinitions, signatures } = parameter;
  const takesTime = paramDefinitions.some((definition) => TIME_TYPES.includes(definition.type));

  // A number where a time span is taken needs its unit.
  if (isLiteral && isNumericType(type) && takesTime) {
    const isOperator = functionDefinition?.type === FunctionDefinitionTypes.OPERATOR;

    return getTimeUnitLiterals(hasMoreMandatoryArgs && !isOperator, hasMoreMandatoryArgs);
  }

  const context = toCallContext(input, call, parameter);
  const builder = new SuggestionBuilder(context);
  const rule = shouldSuggestOperators({
    expressionType: type,
    functionParameterContext: parameter,
    ctx: context,
  });
  // A string, an IP or a version that is written out takes no operator.
  const canExtend = !isLiteral || isNumericType(type) || type === 'boolean';

  if (rule.shouldSuggest && canExtend) {
    builder.addOperators({
      leftParamType: type === 'param' ? undefined : type,
      allowed:
        isLiteral && type === 'boolean'
          ? namesOf(
              logicalOperators.filter((operator) =>
                operator.locationsAvailable.includes(request.location)
              )
            )
          : rule.allowedOperators,
      ignored: [ASSIGNMENT],
    });
  }

  return builder
    .addCommaIfNeeded({
      position: 'after_complete',
      typeMatches: isTypeAcceptedAtPosition(parameter, type, isLiteral),
      isLiteral,
      hasMoreParams: canAcceptMoreArgs(parameter),
      isVariadic: hasVariadicSignature(signatures),
      isAmbiguousPosition: isAmbiguousPosition(parameter),
      isExpressionHeavy: hasArbitraryExpressionSignature(functionDefinition?.signatures ?? []),
      expressionType: type,
      isCursorFollowedByComma: isFollowedByComma,
    })
    .build();
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
 * Inside a string. A query in another language, as the one KQL takes, has suggestions of its
 * own from the editor; any other string has none.
 */
const decideInString = async (input: DecisionInput): Promise<ISuggestionItem[]> =>
  (await getKqlSuggestionsIfApplicable(toBuilderContext(input))) ?? [];

/**
 * Inside the named parameters of a function, `{ "name": value }`: the names its definition
 * lists and the values each takes.
 */
const decideInMap = (input: DecisionInput): ISuggestionItem[] | undefined => {
  const { call } = input.position;
  const definition = call && getFunctionDefinition(call.name);
  const listed = definition && extractSignatureMapParams(definition.signatures);
  const parameters = listed ? Object.entries(parseMapParams(listed)) : [];

  if (!parameters.length) {
    return undefined;
  }

  const { innerText } = toBuilderContext(input);

  return getCommandMapExpressionSuggestions(
    innerText,
    Object.fromEntries(
      parameters.map(([name, parameter]) => [
        name,
        {
          ...parameter,
          suggestions: parameter.values.map((value) => buildMapValueCompleteItem(value)),
        },
      ])
    ),
    true
  );
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
  if (kind === 'in_string') {
    return decideInString(input);
  }
  if (kind === 'in_map') {
    return decideInMap(input);
  }
  if (call) {
    switch (kind) {
      // Right after NOT inside a call is not decided here yet.
      case 'after_not':
        return undefined;
      case 'after_operand':
        return decideAfterOperandInCall(input, call);
      case 'after_operator':
        return decideAfterOperator(input, call);
      default:
        return decideArgumentStart(input, call);
    }
  }

  switch (kind) {
    case 'after_operand':
      return decideAfterOperand(input);
    case 'after_operator':
      return decideAfterOperator(input);
    case 'after_not':
      return decideAfterNot({ ...input, context: toBuilderContext(input) });
    default:
      return decideOperandStart(input);
  }
};
