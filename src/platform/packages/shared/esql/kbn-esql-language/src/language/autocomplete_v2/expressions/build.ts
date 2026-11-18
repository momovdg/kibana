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
import { getKqlSuggestionsIfApplicable } from '../../../commands/definitions/utils/autocomplete/expressions/utils';
import { commaCompleteItem } from '../../../commands/registry/complete_items';
import type { ISuggestionItem } from '../../../commands/registry/types';
import { getSeparatorItem } from '../providers/tokens';
import type { CursorIR } from '../../../esql_js_sim/grammar';
import type { Offer } from './types';

// The grammar name of the bracket that opens the arguments of a function.
const OPENING_BRACKET = 'LP';

/** What the item builders read: the request, with what the grammar says comes next. */
const toBuilderContext = (
  request: SuggestForExpressionParams,
  ir: CursorIR,
  call: Offer['call']
): ExpressionContext => ({
  ...request,
  innerText: request.query.slice(0, request.cursorPosition),
  options: {
    ...request.options,
    isCursorFollowedByComma: ir.next?.class === 'separator',
    isCursorFollowedByParens: ir.next?.token === OPENING_BRACKET,
    ...(call && {
      functionParameterContext: call.parameter,
      parentFunctionNames: call.position.enclosing,
    }),
  },
});

/**
 * The items of an offer. This is the only place of the expression rules that knows the item
 * builders the commands share: a rule says what is offered, this says how it looks.
 */
export const build = async (
  offer: Offer,
  request: SuggestForExpressionParams,
  ir: CursorIR
): Promise<ISuggestionItem[]> => {
  const context = toBuilderContext(request, ir, offer.call);

  if (offer.whole === 'string') {
    return (await getKqlSuggestionsIfApplicable(context)) ?? [];
  }
  if (offer.whole === 'parameter') {
    return suggestForEmptyExpression(context);
  }

  const builder = new SuggestionBuilder(context);
  const { constants, operands, operators, comma, items = [] } = offer;

  if (constants) {
    const { paramDefinitions, hasMoreMandatoryArgs, firstArgumentType } = constants.parameter;
    const built = builder
      .addConstants({
        paramDefinitions,
        shouldAddComma: false,
        hasMoreMandatoryArgs,
        preferredPlaceholderType: firstArgumentType,
        includeValuesControl: true,
        includeConstantFunctions: false,
      })
      .build();

    return built.length || !constants.orElse ? built : build(constants.orElse, request, ir);
  }

  if (operands) {
    const { types, columns, ignoredColumns, spaced, values, literals } = operands;

    if (columns) {
      await builder.addFields({
        types,
        ignoredColumns,
        values,
        addSpaceAfterField: spaced,
        openSuggestions: spaced,
      });
    }
    if (literals) {
      builder.addLiterals({
        types,
        includeDateLiterals: true,
        includeCompatibleLiterals: literals === 'compatible',
        // A literal is an operand as a column is: the same space, the same list after it.
        advanceCursorAndOpenSuggestions: spaced,
      });
    }
    builder.addFunctions({ types });
  }
  if (operators) {
    const { after, allowed, ignored, giving } = operators;
    builder.addOperators({ leftParamType: after, allowed, ignored, returnTypes: giving });
  }
  if (comma) {
    builder.addCommaIfNeeded(comma);
  }

  // The comma that ends an argument is the separator every list has.
  return builder
    .addSuggestions(items)
    .build()
    .map((item) => (item === commaCompleteItem ? getSeparatorItem() : item));
};
