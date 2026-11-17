/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { logicalOperators } from '../../../commands/definitions/all_operators';
import {
  FunctionDefinitionTypes,
  isArrayType,
  isNumericType,
  isParameterType,
  type FunctionParameterType,
  type SupportedDataType,
} from '../../../commands/definitions/types';
import type {
  ExpressionContext,
  PreferredExpressionType,
} from '../../../commands/definitions/utils/autocomplete/expressions/types';
import { shouldSuggestOperators } from '../../../commands/definitions/utils/autocomplete/expressions/positions/after_complete/should_suggest_operators';
import { getCastingTypesSuggestions } from '../../../commands/definitions/utils/autocomplete/expressions/positions/after_cast';
import { getCommandMapExpressionSuggestions } from '../../../commands/definitions/utils/autocomplete/map_expression';
import { getFunctionDefinition } from '../../../commands/definitions/utils/functions';
import { parseMapParams } from '../../../commands/definitions/utils/maps';
import { getTimeUnitLiterals } from '../../../commands/definitions/utils/literals';
import {
  canAcceptMoreArgs,
  extractSignatureMapParams,
  isAmbiguousPosition,
  isTypeAcceptedAtPosition,
} from '../../../commands/definitions/utils/signatures/signature_analyzer';
import {
  hasArbitraryExpressionSignature,
  hasVariadicSignature,
} from '../../../commands/definitions/utils/signatures/traits';
import { getMatchingSignatures } from '../../../commands/definitions/utils/signatures/matchers';
import {
  buildMapValueCompleteItem,
  commaCompleteItem,
  commaWithAutoSuggestCompleteItem,
} from '../../../commands/registry/complete_items';
import { FUNCTION_CALL } from '../../../esql_js_sim/definitions';
import type { CursorIR, WrittenArgument } from '../../../esql_js_sim/grammar';
import { ASSIGNMENT, CAST, partOf } from '../written';
import { joinCondition, offerAfterNot, offerIn, offerLike, offerNullCheck } from './operator_forms';
import { getOperandRange, isOperandOf, type FunctionCallPosition } from './position';
import type { ExpressionType, FunctionParameter, Offer, OfferInput } from './types';

/*
 * What is offered at each position inside an expression. The position comes from the grammar
 * and the types from the type lookup; a rule reads those and returns an offer. Nothing here
 * reads the text or the syntax tree, and nothing builds an item that is not ready-made.
 */

const NOTHING: Offer = {};

/**
 * Where an operand starts and the expression is not inside a function call: the columns and
 * the functions of the types the role accepts. A boolean is usually built from operands of
 * other types, as `a > 1`, so a role that asks for a boolean takes any operand here.
 */
const offerOperandStart = ({ preferred, readsColumns, listedColumns }: OfferInput): Offer => {
  const isStrict =
    preferred.length > 0 && !preferred.includes('boolean') && !preferred.includes('any');

  return {
    operands: {
      types: (isStrict ? preferred : ['any']) as FunctionParameterType[],
      columns: readsColumns,
      ignoredColumns: listedColumns,
      spaced: true,
    },
  };
};

/** The word typed spells a keyword the command expects, and not an operator. */
const isTypedKeyword = ({ word, followers }: CursorIR): boolean =>
  followers.some((follower) => follower.token === word?.keyword && follower.class === 'keyword');

/** A comma of the expression itself, and not one between the arguments of a call in it. */
const isOwnSeparator = (item: WrittenArgument): boolean =>
  item.class === 'separator' && item.ancestors.at(-1)?.id !== FUNCTION_CALL;

const namesOf = (operators: Array<{ name: string }>): string[] => operators.map(({ name }) => name);

/** The operators that join conditions, where the set of functions in use has them. */
const getLogicalNames = ({ location }: OfferInput): string[] =>
  namesOf(logicalOperators.filter((operator) => operator.locationsAvailable.includes(location)));

const NULL_CHECK_END = 'null';

/**
 * Whether operators can follow an operand of a type, and which: all of them when none is
 * named. Inside a function its definition says so; outside one the types the role asks for
 * do, as every operator on a string gives a boolean. The rule is the one the commands share;
 * of the context it reads only those types.
 */
const getOperatorRule = (
  type: ExpressionType,
  { preferred }: OfferInput,
  parameter?: FunctionParameter
) =>
  shouldSuggestOperators({
    expressionType: type,
    functionParameterContext: parameter,
    ctx: { options: { preferredExpressionType: [...preferred] } } as ExpressionContext,
  });

/** What is known of an operand beyond its type. */
interface OperandFacts {
  /** The function whose argument the operand is. */
  call?: Offer['call'];
  /** It is one literal, written out. */
  isLiteral?: boolean;
  /** It is what an operator gives. */
  isResult?: boolean;
}

const isLiteralAlone = (written: Array<{ id: string }>): boolean =>
  written.length === 1 && partOf(written[0]) === 'literal';

/**
 * What can follow a complete operand (a column, a literal, a call, or what an operator
 * gives), wherever it is: the operators that take its type on their left, and inside a
 * function call the comma when the operand can be the whole argument.
 *
 * - A condition that is whole (what an operator gives, or `true` written out) is only joined
 *   to another condition.
 * - Inside a call, a string, an IP or a version that is written out takes no operator.
 */
const offerAfterOperand = (
  input: OfferInput,
  type: ExpressionType,
  { call, isLiteral = false, isResult = false }: OperandFacts
): Offer => {
  if (!isParameterType(type)) {
    return NOTHING;
  }

  const parameter = call?.parameter;
  const rule = getOperatorRule(type, input, parameter);
  const canExtend = !call || !isLiteral || isNumericType(type) || type === 'boolean';
  const isWholeCondition = type === 'boolean' && (isResult || isLiteral);

  return {
    call,
    ...(rule.shouldSuggest &&
      canExtend && {
        operators: {
          after: type === 'param' ? undefined : type,
          allowed: isWholeCondition
            ? rule.allowedOperators ?? getLogicalNames(input)
            : rule.allowedOperators,
          // A match needs a column on its left: what an operator gives is none.
          ignored: isResult ? [ASSIGNMENT, MATCH] : [ASSIGNMENT],
        },
      }),
    ...(parameter && {
      comma: {
        position: 'after_complete',
        typeMatches: isTypeAcceptedAtPosition(parameter, type, isLiteral),
        isLiteral,
        hasMoreParams: canAcceptMoreArgs(parameter),
        isVariadic: hasVariadicSignature(parameter.signatures),
        isAmbiguousPosition: isAmbiguousPosition(parameter),
        isExpressionHeavy: hasArbitraryExpressionSignature(
          parameter.functionDefinition?.signatures ?? []
        ),
        expressionType: type,
        isCursorFollowedByComma: input.ir.next?.class === 'separator',
      },
    }),
  };
};

/**
 * After a complete operand that no operator is written with, outside a function call: the
 * operators that take an operand of its type on their left.
 */
const offerAfterOperandOutsideCall = (input: OfferInput): Offer => {
  const { position, expressionType, allowsSubquery, ir } = input;
  const values = position.written.filter((item) => item.class === 'value' || item.kind === 'rule');
  const brackets = position.written.filter((item) => item.kind === 'token');
  const openers = brackets.filter((item) => item.class === 'opener').length;
  const closers = brackets.filter((item) => item.class === 'closer').length;

  // A list in brackets with no operator before it, as `(a, b)`, is not an operand.
  if (brackets.some(isOwnSeparator)) {
    return NOTHING;
  }
  // A null check is a complete condition: only another condition can be joined to it.
  if (position.operator === NULL_CHECK_END) {
    return { items: joinCondition() };
  }
  // A null check that is not finished, as `a IS`.
  if (position.operator !== undefined) {
    return offerNullCheck(input);
  }
  // A keyword of the command typed in full ends the expression: nothing of it is offered.
  if (isTypedKeyword(ir) || !isParameterType(expressionType)) {
    return NOTHING;
  }

  // Inside brackets that may hold a list, as that of `IN`, the next value can follow.
  const canListNext = allowsSubquery && openers > closers && ir.next?.class === 'closer';

  return {
    ...offerAfterOperand(input, expressionType, { isLiteral: isLiteralAlone(values) }),
    items: canListNext ? [commaWithAutoSuggestCompleteItem] : [],
  };
};

// The operators that have rules of their own.
const NULL_CHECK_WORDS: readonly string[] = ['is', 'null'];
const PATTERN_OPERATORS: readonly string[] = ['like', 'rlike'];
const LIST_OPERATOR = 'in';
const NEGATION = 'not';
const LOGICAL: readonly string[] = ['and', 'or'];
const UNTYPED: readonly string[] = ['unknown', 'unsupported'];
const MATCH = ':';

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
  typeOf: OfferInput['typeOf'],
  range: { start: number; end: number },
  last: WrittenArgument | undefined
): ExpressionType => {
  const closedCall = last?.class === 'closer' && last.ancestors.at(-1);

  return closedCall && closedCall.id === FUNCTION_CALL ? typeOf(closedCall) : typeOf(range);
};

/** The call with what its definition says about the argument at the cursor, when it is known. */
const describeCall = (
  { getParameter }: OfferInput,
  position: FunctionCallPosition | undefined,
  startsArgument = false
): Offer['call'] => {
  const parameter = position && getParameter(position, startsArgument);

  return position && parameter ? { position, parameter } : undefined;
};

/**
 * After an operator. While the operator lacks its right operand: the columns, literals and
 * functions of the types it takes there for the type on its left. Once it has both: the
 * operators that can follow what it gives.
 */
const offerAfterOperator = (input: OfferInput): Offer | undefined => {
  const { ir, position, typeOf, preferred } = input;
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

  // A null check has its own rule.
  if (!definition || NULL_CHECK_WORDS.includes(name)) {
    return undefined;
  }

  // The operators that take a list or a pattern have rules of their own. Those rules are the
  // same inside a function call: they need nothing of what the function takes.
  if (lastOperator && before && name === LIST_OPERATOR) {
    return offerIn(input, lastOperator, following);
  }
  if (lastOperator && before && PATTERN_OPERATORS.includes(name)) {
    const own = offerLike(input, name, following);

    if (own) {
      return own;
    }
  }

  // Inside a call, the definition of the function says what its argument may be.
  const call = describeCall(input, position.call);

  if (position.call && !call) {
    return NOTHING;
  }

  // An operator before its operand, as `NOT a`: what follows is by what the operand gives.
  if (!before) {
    const [first] = following;
    const last = following.at(-1);

    return first && last
      ? offerAfterOperand(
          input,
          getResultType(typeOf, { start: first.start, end: last.end }, last),
          {
            call,
            isResult: true,
          }
        )
      : undefined;
  }

  // What follows the operator and is still its operand: a bracket that closes it is not.
  const after = lastOperator ? following.filter(isOperandOf(lastOperator, before)) : [];
  const lastWritten = after.at(-1);

  // The left operand: what the operator applies to, or all that is written before a typed one.
  const left = lastOperator
    ? getOperandRange(lastOperator, before)
    : { start: position.start ?? before.start, end: before.end };
  const right = lastWritten
    ? getOperandRange(lastOperator ?? lastWritten, lastWritten)
    : lastOperator && ir.word && { start: ir.word.start, end: input.offset };
  const leftType = typeOf(left);
  const rightType = right ? typeOf(right) : 'unknown';

  const offerRest = (): Offer => {
    // The right operand is missing, or is a name that is still being typed.
    if (!right || rightType === 'unknown') {
      // A condition is joined to any operand: the next condition starts with one.
      const types =
        leftType === 'boolean' && LOGICAL.includes(name)
          ? (['any'] as FunctionParameterType[])
          : getRightTypes(definition.signatures, leftType);

      return {
        call,
        operands: { types, columns: true, values: true, spaced: false, literals: 'exact' },
      };
    }

    const isLiteral = [written.slice(0, index), after].map((side) =>
      isLiteralAlone(side.filter((item) => item.kind === 'rule'))
    );
    const fits = getMatchingSignatures(
      definition.signatures,
      [leftType, rightType],
      isLiteral,
      true
    );

    // The operands do not fit the operator, as a string joined to a condition: an operator
    // that makes of the right operand what the role asks for.
    if (!fits.length) {
      const canConvert =
        preferred.length > 0 && !preferred.includes(rightType) && !UNTYPED.includes(rightType);

      return canConvert
        ? {
            call,
            operators: {
              after: rightType as FunctionParameterType,
              giving: preferred as PreferredExpressionType[],
            },
          }
        : NOTHING;
    }

    // What the operator gives; when its right operand is a function call, what the call gives.
    return offerAfterOperand(
      input,
      getResultType(typeOf, { ...left, end: right.end }, lastWritten),
      {
        call,
        isResult: true,
      }
    );
  };

  // The match operator takes a constant of the type its left operand asks for.
  const matched = name === MATCH && !right && input.getParameter({ start: left.start, name }, true);

  return matched ? { call, constants: { parameter: matched, orElse: offerRest() } } : offerRest();
};

const TIME_TYPES: readonly string[] = ['time_duration', 'date_period'];

/**
 * After a complete operand inside a function call: the unit of a time span after its number,
 * or the operators the function lets its argument go on with, and the comma when the operand
 * can be the whole argument.
 */
const offerAfterOperandInCall = (
  input: OfferInput,
  callPosition: FunctionCallPosition
): Offer | undefined => {
  const { position, typeOf, ir } = input;
  const brackets = position.written.filter((item) => item.kind === 'token');
  const last = position.written.at(-1);

  // A list in brackets is not decided here.
  if (!last || position.start === undefined || brackets.some(isOwnSeparator)) {
    return undefined;
  }
  // A null check that is not finished, as `a IS`.
  if (position.operator !== undefined && position.operator !== NULL_CHECK_END) {
    return offerNullCheck(input);
  }

  const call = describeCall(input, callPosition);

  if (!call) {
    return NOTHING;
  }

  const { parameter } = call;
  const isFollowedByComma = ir.next?.class === 'separator';

  // A null check is a complete condition: another one can be joined, or the argument ends.
  if (position.operator === NULL_CHECK_END) {
    const canEnd =
      !isFollowedByComma && (isAmbiguousPosition(parameter) || canAcceptMoreArgs(parameter));

    return { items: [...joinCondition(), ...(canEnd ? [commaCompleteItem] : [])] };
  }

  const type = typeOf({ start: position.start, end: last.end });

  if (type === 'unknown') {
    return NOTHING;
  }

  const isLiteral = isLiteralAlone(position.written.filter((item) => item.kind === 'rule'));
  const { hasMoreMandatoryArgs, functionDefinition, paramDefinitions } = parameter;
  const takesTime = paramDefinitions.some((definition) => TIME_TYPES.includes(definition.type));

  // A number where a time span is taken needs its unit.
  if (isLiteral && isNumericType(type) && takesTime) {
    const isOperator = functionDefinition?.type === FunctionDefinitionTypes.OPERATOR;

    return {
      items: getTimeUnitLiterals(hasMoreMandatoryArgs && !isOperator, hasMoreMandatoryArgs),
    };
  }

  return offerAfterOperand(input, type, { call, isLiteral });
};

/**
 * Where an argument of a function starts: what the definition of the function takes there.
 * The definition decides everything, so the items are those the editor builds for a
 * parameter: its listed values, or the literals, columns and functions of its types.
 */
const offerArgumentStart = (input: OfferInput, callPosition: FunctionCallPosition): Offer => {
  const { ir, position } = input;
  // Nothing of the argument is written, as after a comma or the arrow of a lambda.
  const isNew = !ir.word && position.written.every((item) => item.class === 'opener');
  const call = describeCall(input, callPosition, isNew && ir.previous?.class !== 'opener');

  return call ? { call, whole: 'parameter' } : NOTHING;
};

/**
 * Right after `::`: the types the value before it can be cast to, or every type when no
 * value is written.
 */
const offerAfterCast = ({ position, typeOf }: OfferInput): Offer => {
  const index = position.written.findLastIndex((item) => item.text === CAST);
  const cast = position.written[index];
  const value = position.written[index - 1];

  return {
    items: getCastingTypesSuggestions(
      cast && value ? (typeOf(getOperandRange(cast, value)) as SupportedDataType) : undefined
    ),
  };
};

/**
 * Inside the named parameters of a function, `{ "name": value }`: the names its definition
 * lists and the values each takes.
 */
const offerInMap = ({ position: { call }, textBefore }: OfferInput): Offer | undefined => {
  const definition = call && getFunctionDefinition(call.name);
  const listed = definition && extractSignatureMapParams(definition.signatures);
  const parameters = listed ? Object.entries(parseMapParams(listed)) : [];

  return parameters.length
    ? {
        items: getCommandMapExpressionSuggestions(
          textBefore,
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
        ),
      }
    : undefined;
};

/**
 * What is offered at a position inside an expression. A position with no rule, as after an
 * operator that is not known, gets nothing.
 */
export const offer = (input: OfferInput): Offer => {
  const { kind, call } = input.position;

  switch (kind) {
    // A query in another language, as the one a search function takes, has suggestions of
    // its own from the editor; any other string has none.
    case 'in_string':
      return { whole: 'string' };
    case 'in_map':
      return offerInMap(input) ?? NOTHING;
    case 'after_cast':
      return offerAfterCast(input);
    // The rule for NOT needs nothing of what the function takes.
    case 'after_not':
      return offerAfterNot(input, describeCall(input, call));
    case 'after_operator':
      return offerAfterOperator(input) ?? NOTHING;
    case 'after_operand':
      return (
        (call ? offerAfterOperandInCall(input, call) : offerAfterOperandOutsideCall(input)) ??
        NOTHING
      );
    default:
      return call ? offerArgumentStart(input, call) : offerOperandStart(input);
  }
};
