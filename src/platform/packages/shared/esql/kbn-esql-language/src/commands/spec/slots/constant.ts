/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { buildConstantsDefinitions } from '../../definitions/utils/literals';
import type { ISuggestionItem } from '../../registry/types';
import type { ConstantSlot } from '../types';

/** The values the editor proposes for a constant. One is followed by a space. */
export const offerConstants = ({ suggestedValues = [] }: ConstantSlot): ISuggestionItem[] =>
  buildConstantsDefinitions([...suggestedValues], '', { advanceCursorAndOpenSuggestions: true });
