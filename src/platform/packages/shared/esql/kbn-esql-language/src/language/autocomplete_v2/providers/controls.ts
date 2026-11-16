/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { ControlTriggerSource, ESQLVariableType, type ESQLCallbacks } from '@kbn/esql-types';
import { getControlSuggestionIfSupported } from '../../../commands/definitions/utils/autocomplete/helpers';
import type { ISuggestionItem } from '../../../commands/registry/types';

// The character a control of the editor starts with: one for a value, two for a column.
const CONTROL_PREFIX = '?';

/**
 * The controls of the editor, right after the character that starts one: the ones that exist
 * and the item that creates one. Undefined where the cursor is not after that character.
 */
export const provideControls = (
  fullText: string,
  offset: number,
  callbacks: ESQLCallbacks | undefined
): ISuggestionItem[] | undefined => {
  if (fullText[offset - 1] !== CONTROL_PREFIX) {
    return undefined;
  }

  const type =
    fullText[offset - 2] === CONTROL_PREFIX ? ESQLVariableType.FIELDS : ESQLVariableType.VALUES;

  return getControlSuggestionIfSupported(
    Boolean(callbacks?.canSuggestVariables?.() ?? false),
    type,
    ControlTriggerSource.QUESTION_MARK,
    callbacks?.getVariables?.(),
    false
  );
};
