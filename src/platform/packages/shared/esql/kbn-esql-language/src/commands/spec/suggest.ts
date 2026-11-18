/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLAstAllCommands, ESQLAstField, ESQLCommandOption } from '@elastic/esql/types';
import { ENTITY_FACTS, type ExpressionMode } from '../../esql_js_sim/definitions';
import { getEsqlLexerTokens, isVisibleToken } from '../../language/shared/lexer_scope';
import {
  buildUserDefinedColumnsDefinitions,
  withAutoSuggest,
} from '../definitions/utils/autocomplete/helpers';
import { suggestFieldsList } from '../definitions/utils/autocomplete/fields_list';
import { buildFieldsDefinitions } from '../definitions/utils/functions';
import {
  assignCompletionItem,
  commaCompleteItem,
  getNewUserDefinedColumnSuggestion,
  newLineAndPipeCompleteItems,
} from '../registry/complete_items';
import {
  buildPoliciesDefinitions,
  getPolicyMetadata,
  noPoliciesAvailableSuggestion,
} from '../registry/enrich/util';
import type { ICommandMethods } from '../registry/registry';
import {
  Location,
  type ICommandCallbacks,
  type ICommandContext,
  type ISuggestionItem,
} from '../registry/types';
import {
  matchSpec,
  type Expected,
  type FilledSlot,
  type SpecPosition,
  type SpecToken,
} from './match';
import type { CommandSpec, SlotNode, SpecNode } from './types';

/*
 * The autocomplete of any command that has a spec: find the slot at the cursor, and offer what
 * the role of the slot says. Nothing here knows a command.
 */

const WORD_START = /^[\w@`"?*.-]/;
const QUALIFIER_JOINER = ':';

/** The set of functions a kind of expression takes, in the terms of the function definitions. */
const getLocation = (mode: ExpressionMode): Location =>
  ({
    scalar: Location.EVAL,
    aggregation: Location.STATS,
    grouping: Location.STATS_BY,
    key: Location.LIMIT_BY,
    filter: Location.WHERE,
    constant: Location.ROW,
    full_text: Location.HIGHLIGHT_QUERY,
  }[mode]);

interface Environment {
  spec: CommandSpec;
  query: string;
  cursorPosition: number;
  command: ESQLAstAllCommands;
  callbacks?: ICommandCallbacks;
  context?: ICommandContext;
  position: SpecPosition;
  /** The word being typed at the cursor. */
  typed?: string;
}

/** The tokens of the command after its name, without the word that is being typed. */
const toTokens = (
  innerText: string,
  command: ESQLAstAllCommands
): { tokens: SpecToken[]; typed?: string } => {
  const nameLength = command.name.split(' ').length;
  const tokens = getEsqlLexerTokens(innerText)
    .filter(isVisibleToken)
    .filter(({ start }) => start >= command.location.min)
    .slice(nameLength)
    .map(({ text, start, stop }) => ({ text, start, end: stop + 1 }));
  const last = tokens.at(-1);

  // The lexer leaves out the joiner of a qualifier until the name after it is written.
  if (last && innerText[last.end] === QUALIFIER_JOINER) {
    last.text += QUALIFIER_JOINER;
    last.end += QUALIFIER_JOINER.length;
  }

  const isTypingWord =
    last !== undefined && last.end === innerText.length && WORD_START.test(last.text);

  return isTypingWord ? { tokens: tokens.slice(0, -1), typed: last.text } : { tokens };
};

/** The node that comes right after a slot in the spec, and the keyword right before it. */
const neighboursOf = (
  nodes: SpecNode[],
  slot: SlotNode
): { next?: SpecNode; keywordBefore?: string } | undefined => {
  for (const [index, node] of nodes.entries()) {
    if (node === slot) {
      const before = nodes[index - 1];

      return {
        next: nodes[index + 1],
        keywordBefore: before?.kind === 'keyword' ? before.text : undefined,
      };
    }

    const inner =
      node.kind === 'optional' || node.kind === 'repeat'
        ? neighboursOf(node.nodes, slot)
        : undefined;

    if (inner) {
      return inner;
    }
  }

  return undefined;
};

/** What the tree has for a slot: the arguments of the option its keyword opens, or the command's. */
const getFields = (command: ESQLAstAllCommands, keywordBefore?: string): ESQLAstField[] => {
  const options: ESQLCommandOption[] = [];
  const others: ESQLAstField[] = [];

  for (const arg of command.args) {
    if (!Array.isArray(arg) && arg.type === 'option') {
      options.push(arg);
    } else {
      others.push(arg as ESQLAstField);
    }
  }

  const option = options.find(({ name }) => name === keywordBefore?.toLowerCase());

  return keywordBefore ? ((option?.args ?? []) as ESQLAstField[]) : others;
};

/** The words that may come before the name of an entity, as the mode of an enrich policy. */
const provideQualifiers = (slot: SlotNode, typed: string | undefined): ISuggestionItem[] => {
  const { qualifiers = [] } = slot.role.kind === 'entity' ? ENTITY_FACTS[slot.role.entityType] : {};

  return typed === undefined
    ? []
    : qualifiers
        .filter((qualifier) => qualifier.startsWith(typed.toLowerCase()))
        .map((qualifier) =>
          withAutoSuggest({
            label: qualifier,
            text: `${qualifier}${QUALIFIER_JOINER}$0`,
            asSnippet: true,
            kind: 'Reference',
            detail: '',
          })
        );
};

/** Whether what is written for a slot is one of the things its role names. */
const isKnown = ({ slot, text }: FilledSlot, { context, position }: Environment): boolean => {
  const { role } = slot;
  const name = text.replace(/`/g, '');

  if (role.kind === 'column') {
    return context?.columns?.has(name) ?? false;
  }
  if (role.kind === 'entity' && ENTITY_FACTS[role.entityType].parent) {
    const owner = position.filled.find(
      ({ slot: filled }) =>
        filled.role.kind === 'entity' &&
        filled.role.entityType === ENTITY_FACTS[role.entityType].parent
    );
    const metadata = owner && getPolicyMetadata(context?.policies ?? new Map(), owner.text);

    return metadata?.enrichFields.includes(name) ?? false;
  }

  return true;
};

/** The name and symbol that may come before a slot, as `new_name =` before a value. */
const getAssignmentBefore = (nodes: SpecNode[], slot: SlotNode): SpecNode[] | undefined => {
  for (const [index, node] of nodes.entries()) {
    const before = nodes[index - 1];

    if (node === slot) {
      const prefix = before?.kind === 'optional' ? before.nodes : [];
      const [name, mark] = prefix;

      return name?.kind === 'slot' && mark?.kind === 'symbol' ? prefix : undefined;
    }
    if (node.kind === 'optional' || node.kind === 'repeat') {
      const inner = getAssignmentBefore(node.nodes, slot);

      if (inner) {
        return inner;
      }
    }
  }

  return undefined;
};

const provideKeyword = (text: string): ISuggestionItem =>
  withAutoSuggest({ label: text, text: `${text} `, kind: 'Reference', detail: '' });

/** The items for what is not a slot: a keyword, a symbol, the end of the command. */
const provideExpected = (expected: Expected): ISuggestionItem[] => {
  switch (expected.kind) {
    case 'keyword':
      return [provideKeyword(expected.text)];
    case 'symbol':
      return expected.text === ','
        ? [withAutoSuggest({ ...commaCompleteItem, text: ', ' })]
        : [assignCompletionItem];
    case 'end':
      return newLineAndPipeCompleteItems;
    default:
      return [];
  }
};

/** The items for a slot, by its role alone. */
const provideSlot = async (slot: SlotNode, env: Environment): Promise<ISuggestionItem[]> => {
  const { spec, command, callbacks, context, position, query, cursorPosition } = env;
  const { role } = slot;
  const { next, keywordBefore } = neighboursOf(spec, slot) ?? {};
  const isFollowedBy = (text: string) => next?.kind === 'symbol' && next.text === text;

  switch (role.kind) {
    case 'column':
      return (
        (await callbacks?.getByType?.(role.types ? [...role.types] : 'any', [], {
          advanceCursor: true,
          openSuggestions: true,
        })) ?? []
      );
    case 'new_name': {
      // A name the editor proposes comes with the symbol that has to follow it.
      if (slot.suggestedName) {
        return buildUserDefinedColumnsDefinitions([slot.suggestedName]).map((item) =>
          withAutoSuggest({ ...item, text: isFollowedBy(',') ? `${item.text}, ` : item.text })
        );
      }

      return isFollowedBy('=')
        ? [
            getNewUserDefinedColumnSuggestion(
              callbacks?.getSuggestedUserDefinedColumnName?.() || ''
            ),
          ]
        : [];
    }
    case 'entity': {
      const policies = context?.policies ?? new Map();
      const { parent } = ENTITY_FACTS[role.entityType];

      // An entity that belongs to another is listed from the one that is written.
      if (parent) {
        const owner = position.filled.find(
          ({ slot: filled }) => filled.role.kind === 'entity' && filled.role.entityType === parent
        );
        const metadata = owner && getPolicyMetadata(policies, owner.text);

        return metadata ? buildFieldsDefinitions(metadata.enrichFields, false) : [];
      }

      const items = buildPoliciesDefinitions(Array.from(policies.values()));

      return items.length ? items : [noPoliciesAvailableSuggestion];
    }
    case 'expression':
      return suggestFieldsList(
        query,
        command,
        getFields(command, keywordBefore),
        getLocation(role.mode),
        callbacks,
        context,
        cursorPosition,
        {
          allowSingleColumnFields: role.computes !== true,
          disableNewColumnSuggestion: role.computes !== true,
          // Where each item is listed once, the columns that are an item already are left out.
          ...(role.unique && {
            ignoredColumnsForEmptyExpression: getFields(command, keywordBefore).flatMap((field) =>
              !Array.isArray(field) && field.type === 'column' ? [field.parts.join('.')] : []
            ),
          }),
          // What the spec allows after the list is offered once the last item is whole.
          afterCompleteSuggestions: position.expected
            .filter(({ kind }) => kind === 'keyword')
            .flatMap(provideExpected),
        }
      );
    default:
      return [];
  }
};

/** The autocomplete of a command, from its spec. */
export const createSpecAutocomplete =
  (spec: CommandSpec): ICommandMethods<ICommandContext>['autocomplete'] =>
  async (query, command, callbacks, context, cursorPosition = query.length) => {
    const innerText = query.substring(0, cursorPosition);
    const { tokens, typed } = toTokens(innerText, command);
    const position = matchSpec(spec, tokens);
    const env: Environment = {
      spec,
      query,
      cursorPosition,
      command,
      callbacks,
      context,
      position,
      typed,
    };
    const last = position.filled.at(-1);
    const isAfterLast = last !== undefined && last.end === tokens.at(-1)?.end;

    if (position.isInvalid) {
      return [];
    }
    // A qualifier is written and its name is not: the name comes right after it, or nothing.
    if (isAfterLast && last.text.endsWith(QUALIFIER_JOINER)) {
      return last.end === innerText.length ? provideSlot(last.slot, env) : [];
    }
    // A name that is not one of the things expected there can only be a new name: the symbol
    // that assigns it is all that can follow.
    if (isAfterLast && typed === undefined && !isKnown(last, env)) {
      const [, mark] = getAssignmentBefore(spec, last.slot) ?? [];

      if (mark?.kind === 'symbol') {
        return provideExpected({ kind: 'symbol', text: mark.text });
      }
    }
    // Inside an expression, or right after one, the expression says what comes next: its
    // operators, and what follows it once it is whole.
    if (position.open?.slot.role.kind === 'expression') {
      return provideSlot(position.open.slot, env);
    }

    const items = await Promise.all(
      position.expected.map(async (expected) => {
        if (expected.kind !== 'slot') {
          return provideExpected(expected);
        }

        // A word that starts a qualifier is one: the names come after it.
        const qualifiers = provideQualifiers(expected.slot, typed);

        return qualifiers.length ? qualifiers : provideSlot(expected.slot, env);
      })
    );

    return items.flat();
  };
