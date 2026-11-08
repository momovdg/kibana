/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

// Prototype of what esql-js would provide; see README.md. Kibana code imports only this file.
import { GRAMMAR_LABELS } from './grammar_labels/grammar_labels.generated';
import type { CallSite, GrammarLabel } from './grammar_labels/types';
import {
  ARGUMENT_REQUIRED_COMMANDS,
  ARGUMENT_ROLES,
  SINGLE_USE_RULES,
  UNLABELLED_ARGUMENT_ROLES,
} from './argument_roles/argument_roles';
import type { ArgumentRole, MapParameter } from './argument_roles/types';

export { ARGUMENT_REQUIRED_COMMANDS, GRAMMAR_LABELS, SINGLE_USE_RULES };
export { getCallSites } from './grammar_labels/call_sites';
export { RULE_END, RULE_START } from './grammar_labels/types';
export type { CallSite, GrammarLabel, ArgumentRole, MapParameter };

/**
 * The role of the argument at a call site, if classified: by its label, or by the rule and the
 * rule called when the grammar does not label it, as LIMIT's row count.
 */
export const getArgumentRole = ({ rule, label, invokes }: CallSite): ArgumentRole | undefined =>
  label
    ? getLabelledArgumentRole(`${rule}.${label}`)
    : UNLABELLED_ARGUMENT_ROLES[`${rule}>${invokes}`];

/** The role of a labelled argument by its `rule.label` name, e.g. `fuseCommand.fuseType`. */
export const getLabelledArgumentRole = (name: string): ArgumentRole | undefined =>
  ARGUMENT_ROLES[name];
