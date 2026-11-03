/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { withAutoSuggest } from '../../definitions/utils/autocomplete/helpers';
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import type { CursorLocation } from '../../../language/shared/cursor_location/types';
import type { ESQLPolicy, ISuggestionItem } from '../types';
import { getSafeInsertText } from '../../definitions/utils/autocomplete/helpers';
import { SuggestionCategory } from '../../../language/autocomplete/utils/sorting/types';

export const ENRICH_MODES = [
  {
    name: 'any',
    description: i18n.translate('esqlLanguage.esql.definitions.ccqAnyDoc', {
      defaultMessage: 'Enrich takes place on any cluster',
    }),
  },
  {
    name: 'coordinator',
    description: i18n.translate('esqlLanguage.esql.definitions.ccqCoordinatorDoc', {
      defaultMessage: 'Enrich takes place on the coordinating cluster receiving an ES|QL',
    }),
  },
  {
    name: 'remote',
    description: i18n.translate('esqlLanguage.esql.definitions.ccqRemoteDoc', {
      defaultMessage: 'Enrich takes place on the cluster hosting the target index.',
    }),
  },
];

export const buildPoliciesDefinitions = (
  policies: Array<{ name: string; sourceIndices: string[] }>
): ISuggestionItem[] =>
  policies.map(({ name: label, sourceIndices }) =>
    withAutoSuggest({
      label,
      text: getSafeInsertText(label, { dashSupported: true }) + ' ',
      kind: 'Class',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.policyDefinition', {
        defaultMessage: `Policy defined on {count, plural, one {index} other {indices}}: {indices}`,
        values: {
          count: sourceIndices.length,
          indices: sourceIndices.join(', '),
        },
      }),
    })
  );

export const getPolicyMetadata = (policies: Map<string, ESQLPolicy>, policyName: string) => {
  return policies.get(policyName);
};

export enum Position {
  MODE = 'mode',
  POLICY = 'policy',
  AFTER_POLICY = 'after_policy',
  MATCH_FIELD = 'match_field',
  AFTER_ON_CLAUSE = 'after_on_clause',
  WITH_NEW_CLAUSE = 'with_new_clause',
  WITH_AFTER_FIRST_WORD = 'with_after_first_word',
  WITH_AFTER_ASSIGNMENT = 'with_after_assignment',
  WITH_AFTER_COMPLETE_CLAUSE = 'with_after_complete_clause',
}

/** Maps the grammar's view of the cursor to an ENRICH position. */
export const getPosition = ({
  expectedTokens,
  expectedRules,
  partial,
  commandCanEnd,
  previousTokenType,
  whitespaceBefore,
  skippedText,
}: CursorLocation): Position | undefined => {
  // The lexer dropped text the grammar cannot place, e.g. `_any: ` with a space after the mode.
  if (skippedText) {
    return undefined;
  }

  const slot = expectedRules.find(({ continuation }) => !continuation);

  if (slot?.rule === 'enrichPolicyName') {
    // `_any:policy` is a single token; only the `_mode` part before the colon is a mode.
    return partial?.text.startsWith('_') && !partial.text.includes(':')
      ? Position.MODE
      : Position.POLICY;
  }
  if (expectedTokens.has(getTokenType('ON'))) {
    return Position.AFTER_POLICY;
  }

  if (slot && slot.stack[slot.stack.length - 1] !== 'enrichWithClause') {
    return Position.MATCH_FIELD;
  }
  if (slot) {
    if (previousTokenType === getTokenType('ASSIGN')) {
      return Position.WITH_AFTER_ASSIGNMENT;
    }
    // A new WITH clause is only suggested once a space follows WITH or the comma.
    return whitespaceBefore ? Position.WITH_NEW_CLAUSE : undefined;
  }

  // Keywords and separators are only suggested after a space, not while a word is typed.
  if (partial) {
    return undefined;
  }
  if (expectedTokens.has(getTokenType('ASSIGN'))) {
    return Position.WITH_AFTER_FIRST_WORD;
  }
  if (expectedTokens.has(getTokenType('WITH'))) {
    return Position.AFTER_ON_CLAUSE;
  }
  if (commandCanEnd && expectedTokens.has(getTokenType('COMMA'))) {
    return Position.WITH_AFTER_COMPLETE_CLAUSE;
  }
};

/** The first word of the WITH clause at the cursor, as typed. */
export const getWithClauseFirstWord = ({ expectedRules }: CursorLocation): string =>
  expectedRules.find(({ rule, continuation }) => continuation && rule === 'qualifiedNamePattern')
    ?.text ?? '';

export const noPoliciesAvailableSuggestion: ISuggestionItem = {
  label: i18n.translate('esqlLanguage.esql.autocomplete.noPoliciesLabel', {
    defaultMessage: 'No available policy',
  }),
  text: '',
  kind: 'Issue',
  detail: i18n.translate('esqlLanguage.esql.autocomplete.noPoliciesLabelsFound', {
    defaultMessage: 'Click to create',
  }),
  category: SuggestionCategory.CUSTOM_ACTION,
  command: {
    id: 'esql.policies.create',
    title: i18n.translate('esqlLanguage.esql.autocomplete.createNewPolicy', {
      defaultMessage: 'Click to create',
    }),
  },
};

export const modeDescription = i18n.translate('esqlLanguage.esql.definitions.ccqMode', {
  defaultMessage: 'Cross-cluster query mode',
});

export const modeSuggestions: ISuggestionItem[] = ENRICH_MODES?.map(({ name, description }) =>
  withAutoSuggest({
    label: `_${name}`,
    text: `_${name}:$0`,
    asSnippet: true,
    kind: 'Reference',
    detail: i18n.translate('esqlLanguage.esql.definitions.ccqModeDoc', {
      defaultMessage: 'Cross-cluster query mode - ${description}',
      values: {
        description,
      },
    }),
  })
);

export const onSuggestion: ISuggestionItem = withAutoSuggest({
  label: 'ON',
  text: 'ON ',
  kind: 'Reference',
  detail: i18n.translate('esqlLanguage.esql.definitions.onDoc', {
    defaultMessage: 'On',
  }),
});

export const withSuggestion: ISuggestionItem = withAutoSuggest({
  label: 'WITH',
  text: 'WITH ',
  kind: 'Reference',
  detail: i18n.translate('esqlLanguage.esql.definitions.withDoc', {
    defaultMessage: 'With',
  }),
});

export const buildMatchingFieldsDefinition = (
  matchingField: string,
  fields: string[]
): ISuggestionItem[] =>
  fields.map((label) =>
    withAutoSuggest({
      label,
      text: getSafeInsertText(label) + ' ',
      kind: 'Variable',
      detail: i18n.translate('esqlLanguage.esql.autocomplete.matchingFieldDefinition', {
        defaultMessage: `Use to match on {matchingField} on the policy`,
        values: {
          matchingField,
        },
      }),
      category: SuggestionCategory.FIELD,
    })
  );
