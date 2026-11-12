/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import type { ICommandMethods } from '../registry';
import { columnsAfter } from './columns_after';
import { validate } from './validate';
import { summary } from './summary';
import type { ICommandContext } from '../types';

const completionCommandMethods: ICommandMethods<ICommandContext> = {
  validate,
  columnsAfter,
  summary,
};

export const completionCommand = {
  name: 'completion',
  methods: completionCommandMethods,
  metadata: {
    docPreserving: true,
    preview: true,
    description: i18n.translate('esqlLanguage.esql.definitions.completionDoc', {
      defaultMessage:
        'Send prompts to an LLM. Requires an inference endpoint set up for `completion` tasks.',
    }),
    declaration: 'COMPLETION [target_field =] prompt WITH { "inference_id": "model_id" }',
    examples: [
      `ROW question = "What is Elasticsearch?"
| COMPLETION answer = question WITH { "inference_id": "test_completion_model" }
| KEEP question, answer`,
    ],
  },
};
