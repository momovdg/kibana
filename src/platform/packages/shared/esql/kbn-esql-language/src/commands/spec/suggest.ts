/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { Walker } from '@elastic/esql';
import type { ESQLAstAllCommands, ESQLAstField, ESQLCommandOption } from '@elastic/esql/types';
import { esqlCommandRegistry } from '../registry';
import { ENTITY_FACTS, type ExpressionMode } from '../../esql_js_sim/definitions';
import { getEsqlLexerTokens, isVisibleToken } from '../../language/shared/lexer_scope';
import {
  buildUserDefinedColumnsDefinitions,
  withAutoSuggest,
} from '../definitions/utils/autocomplete/helpers';
import { suggestFieldsList } from '../definitions/utils/autocomplete/fields_list';
import {
  getCommandMapExpressionSuggestions,
  type MapParameters,
} from '../definitions/utils/autocomplete/map_expression';
import { suggestForExpression } from '../definitions/utils/autocomplete/expressions';
import { getAllFunctions, getFunctionDefinition } from '../definitions/utils/functions';
import { FunctionDefinitionTypes } from '../definitions/types';
import { findExpressionRoot } from '../../language/autocomplete_v2/expressions/tree';
import { buildFieldsDefinitions } from '../definitions/utils/functions';
import {
  assignCompletionItem,
  commaCompleteItem,
  buildMapValueCompleteItem,
  getCommandAutocompleteDefinitions,
  getDateHistogramCompletionItem,
  getNewUserDefinedColumnSuggestion,
  getTimeseriesDateHistogramCompletionItem,
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
  type MatchOptions,
  type Expected,
  type FilledSlot,
  type SpecPosition,
  type SpecToken,
} from './match';
import { provideMetadataFields, provideSources } from './sources';
import { provideSublanguage } from './sublanguage';
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
  tokens: SpecToken[];
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

/** The sequences a node holds: its own, or one per alternative. */
const childrenOf = (node: SpecNode): SpecNode[][] => {
  if (node.kind === 'optional' || node.kind === 'repeat') {
    return [node.nodes];
  }

  return node.kind === 'choice' ? node.alternatives : [];
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

    const inner = childrenOf(node)
      .map((nodes_) => neighboursOf(nodes_, slot))
      .find(Boolean);

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

  if (role.kind === 'column' || (role.kind === 'expression' && NAME.test(text))) {
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
    const inner = childrenOf(node)
      .map((nodes_) => getAssignmentBefore(nodes_, slot))
      .find(Boolean);

    if (inner) {
      return inner;
    }
  }

  return undefined;
};

/** The node that follows a keyword or a word in the spec. */
const afterKeyword = (nodes: SpecNode[], text: string): SpecNode | undefined => {
  for (const [index, node] of nodes.entries()) {
    if ((node.kind === 'keyword' || node.kind === 'word') && node.text === text) {
      return nodes[index + 1];
    }

    const inner =
      node.kind === 'optional' || node.kind === 'repeat'
        ? afterKeyword(node.nodes, text)
        : node.kind === 'choice'
        ? node.alternatives.map((nodes_) => afterKeyword(nodes_, text)).find(Boolean)
        : undefined;

    if (inner) {
      return inner;
    }
  }

  return undefined;
};

/**
 * A keyword, by what the spec has right after it: with the braces of a map where only a map
 * can follow, with its assignment where it is assigned a value, with a space otherwise.
 */
const provideKeyword = (text: string, spec: CommandSpec): ISuggestionItem => {
  const next = afterKeyword(spec, text);

  if (next?.kind === 'slot' && next.role.kind === 'map') {
    return withAutoSuggest({
      label: text,
      text: `${text} { $0 }`,
      asSnippet: true,
      kind: 'Reference',
      detail: '',
    });
  }

  const suffix = next?.kind === 'symbol' ? ` ${next.text} ` : ' ';

  return withAutoSuggest({ label: text, text: `${text}${suffix}`, kind: 'Reference', detail: '' });
};

/** The brackets of a new pipeline, the cursor inside. */
const getNewBranchItem = (): ISuggestionItem =>
  withAutoSuggest({
    kind: 'Issue',
    label: i18n.translate('esqlLanguage.esql.suggestions.newBranchLabel', {
      defaultMessage: 'New branch',
    }),
    detail: i18n.translate('esqlLanguage.esql.suggestions.newBranchDetail', {
      defaultMessage: 'Add a new branch to the fork',
    }),
    text: '($0)',
    asSnippet: true,
  });

/** The items for what is not a slot: a keyword, a symbol, the end of the command. */
const provideExpected = (expected: Expected, spec: CommandSpec): ISuggestionItem[] => {
  switch (expected.kind) {
    case 'keyword':
      return [provideKeyword(expected.text, spec)];
    case 'symbol':
      return expected.text === ','
        ? [withAutoSuggest({ ...commaCompleteItem, text: ', ' })]
        : [assignCompletionItem];
    case 'end':
      return newLineAndPipeCompleteItems;
    case 'branch':
      return [getNewBranchItem()];
    default:
      return [];
  }
};

const NAME = /^[^\s()]+$/;
const AGGREGATING = [FunctionDefinitionTypes.AGG, FunctionDefinitionTypes.TIME_SERIES_AGG];
// The kinds of expression that read a column only as the argument of a function.
const COLUMNS_IN_CALLS_ONLY: readonly ExpressionMode[] = ['aggregation', 'constant', 'full_text'];

const namesOfType = (type: FunctionDefinitionTypes): string[] =>
  getAllFunctions({ type }).map(({ name }) => name);

/** The sequence of the spec a slot is in. */
const sequenceOf = (nodes: SpecNode[], slot: SlotNode): SpecNode[] | undefined => {
  if (nodes.includes(slot)) {
    return nodes;
  }

  for (const node of nodes) {
    const inner = childrenOf(node)
      .map((nodes_) => sequenceOf(nodes_, slot))
      .find(Boolean);

    if (inner) {
      return inner;
    }
  }

  return undefined;
};

/**
 * One expression: what continues it, and once it is whole, what the spec allows after it.
 * The expression engine the commands share decides the first; the spec says the second.
 */
const provideExpression = async (slot: SlotNode, env: Environment): Promise<ISuggestionItem[]> => {
  const { spec, query, cursorPosition, command, callbacks, context, position, tokens } = env;
  const { role } = slot;

  if (role.kind !== 'expression') {
    return [];
  }

  const written = position.open?.slot === slot ? position.open : undefined;
  const own = tokens.filter(({ start }) => written !== undefined && start >= written.start);
  const depth = own.reduce(
    (open, { text }) => open + (text === '(' ? 1 : text === ')' ? -1 : 0),
    0
  );
  const sequence = sequenceOf(spec, slot) ?? [];
  const before = sequence.slice(0, sequence.indexOf(slot));
  const isAssigned = written !== undefined && tokens[tokens.indexOf(own[0]) - 1]?.text === '=';
  // A filter that belongs to an aggregation takes what a filter of aggregations takes.
  const follows = (mode: ExpressionMode): boolean =>
    before.some(
      (node) => node.kind === 'slot' && node.role.kind === 'expression' && node.role.mode === mode
    );
  const location =
    role.mode === 'filter' && follows('aggregation')
      ? Location.STATS_WHERE
      : role.mode === 'aggregation' && context?.isTimeseriesSource && depth > 0
      ? Location.STATS_TIMESERIES
      : getLocation(role.mode);
  // The functions written in the item, by the word before each bracket.
  const readsColumns = !COLUMNS_IN_CALLS_ONLY.includes(role.mode) || depth > 0;
  const calls = own
    .filter((_, index) => own[index + 1]?.text === '(')
    .map(({ text }) => text.toLowerCase());
  const others = position.filled.filter((filled) => filled.slot === slot && filled !== written);

  const { suggestions, computed } = await suggestForExpression({
    query,
    expressionRoot: written && findExpressionRoot(command, written.start),
    command,
    cursorPosition,
    location,
    context,
    // Where a column can only be the argument of a function, none is listed outside one.
    callbacks: readsColumns ? callbacks : { ...callbacks, getByType: undefined },
    options: {
      ...(role.types && { preferredExpressionType: [...role.types] }),
      ...(role.subqueries && { allowSubquery: true }),
      ...(!readsColumns && { suggestFields: false }),
      // Where each item is listed once, the columns that are an item already are left out.
      ...(role.unique && {
        ignoredColumnsForEmptyExpression: others
          .filter(({ text }) => NAME.test(text))
          .map(({ text }) => text),
      }),
      getFunctionsToIgnore: (parameter) => {
        const isGrouping = parameter?.functionDefinition?.type === FunctionDefinitionTypes.GROUPING;
        const takesAggregation = parameter?.paramDefinitions.some(
          ({ hint }) => hint?.kind === 'aggregation'
        );
        const usedKinds = AGGREGATING.filter((type) =>
          calls.some((name) => getFunctionDefinition(name)?.type === type)
        );

        return {
          names: [
            // No grouping inside a grouping, and no aggregation inside an aggregation.
            ...(isGrouping ? namesOfType(FunctionDefinitionTypes.GROUPING) : []),
            ...(parameter && role.mode === 'aggregation'
              ? [...calls, ...(takesAggregation ? [] : usedKinds.flatMap(namesOfType))]
              : []),
          ],
        };
      },
    },
  });

  // A column alone computes nothing where the items are computed values: it is not whole
  // yet, and it may still be the name of the item.
  const isLoneName = written !== undefined && NAME.test(written.text);
  const isWhole =
    written !== undefined &&
    computed.isComplete &&
    (!role.completeAs || computed.expressionType === role.completeAs) &&
    !computed.insideFunction &&
    !(role.computes && isLoneName && !isAssigned);

  // Where a grouping starts, the editor also offers a ready-made date histogram.
  const histogram =
    role.mode === 'grouping' && written === undefined
      ? [
          (context?.isTimeseriesSource
            ? getTimeseriesDateHistogramCompletionItem
            : getDateHistogramCompletionItem)(context?.histogramBarTarget),
        ]
      : [];

  // A ready-made string the editor proposes where the expression starts, selected once inserted.
  const placeholder =
    slot.placeholder !== undefined && written === undefined && env.typed === undefined
      ? [
          {
            label: slot.placeholder,
            text: `"\${0:${slot.placeholder}}"`,
            asSnippet: true,
            kind: 'Constant' as const,
            detail: '',
          },
        ]
      : [];

  return [
    ...placeholder,
    ...suggestions,
    ...histogram,
    ...(isWhole ? position.expected.flatMap((expected) => provideExpected(expected, spec)) : []),
  ];
};

/** The items for a slot, by its role alone. */
const provideSlot = async (slot: SlotNode, env: Environment): Promise<ISuggestionItem[]> => {
  const { spec, command, callbacks, context, position, query, cursorPosition } = env;
  const { role } = slot;
  const { next, keywordBefore } = neighboursOf(spec, slot) ?? {};
  const isFollowedBy = (text: string) => next?.kind === 'symbol' && next.text === text;

  switch (role.kind) {
    case 'column': {
      // In a list the columns already listed are left out, and a comma can follow a name.
      const written = position.open?.slot === slot ? position.open.text.split(',') : [];
      const listed = written.map((name) => name.trim()).filter(Boolean);
      const columns =
        (await callbacks?.getByType?.(
          role.types ? [...role.types] : 'any',
          role.unique ? listed : [],
          {
            advanceCursor: !slot.list,
            openSuggestions: true,
          }
        )) ?? [];
      const everything =
        role.wildcard === 'alone' && !listed.length
          ? [{ label: '*', text: '*', kind: 'Variable' as const, detail: '' }]
          : [];

      return [...everything, ...columns];
    }
    case 'constant':
      // The value Elasticsearch uses by default, in quotes and selected so typing replaces it.
      return role.default !== undefined && role.valueType === 'string'
        ? [
            {
              label: `"${role.default}"`,
              text: `"\${0:${role.default}}"`,
              asSnippet: true,
              kind: 'Constant',
              detail: '',
            },
          ]
        : [];
    case 'map': {
      const parameters: MapParameters = Object.fromEntries(
        Object.entries(role.parameters).map(([name, parameter]) => [
          name,
          {
            type: ['integer', 'double', 'long'].includes(parameter.type) ? 'number' : 'string',
            suggestions: [
              // The values of a parameter that names an entity are the ones the editor has.
              ...(parameter.entityType === 'inference_endpoint'
                ? (context?.inferenceEndpoints ?? []).map(({ inference_id: id }) => id)
                : parameter.values ?? (parameter.default ? [parameter.default] : [])),
            ].map((value) => buildMapValueCompleteItem(value)),
          },
        ])
      ) as MapParameters;

      // Nothing of the map is written: its braces, opened with the parameter a query usually gives.
      if (position.open?.slot !== slot) {
        const content = slot.opensWith ? `"${slot.opensWith}": "$0"` : '$0';

        return [
          withAutoSuggest({
            label: `{ ${content.replace('$0', '')} }`,
            text: `{ ${content} }`,
            asSnippet: true,
            kind: 'Reference',
            detail: '',
          }),
        ];
      }

      return getCommandMapExpressionSuggestions(query.substring(0, cursorPosition), parameters);
    }
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
      const following = position.expected
        .filter(({ kind }) => kind !== 'slot')
        .flatMap((expected) => provideExpected(expected, spec));

      if (role.entityType === 'source') {
        return provideSources({
          slot,
          query,
          cursorPosition,
          command,
          callbacks,
          context,
          following,
        });
      }
      if (role.entityType === 'metadata_field') {
        return provideMetadataFields({ query, cursorPosition, command, callbacks });
      }

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
      return slot.list
        ? suggestFieldsList(
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
                ignoredColumnsForEmptyExpression: getFields(command, keywordBefore).flatMap(
                  (field) =>
                    !Array.isArray(field) && field.type === 'column' ? [field.parts.join('.')] : []
                ),
              }),
              // What the spec allows after the list is offered once the last item is whole.
              afterCompleteSuggestions: position.expected
                .filter(({ kind }) => kind === 'keyword')
                .flatMap((expected) => provideExpected(expected, spec)),
            }
          )
        : provideExpression(slot, env);
    default:
      return [];
  }
};

/** The autocomplete of a command, from its spec. */
export const createSpecAutocomplete =
  (
    spec: CommandSpec,
    options: MatchOptions = {}
  ): ICommandMethods<ICommandContext>['autocomplete'] =>
  async (query, command, callbacks, context, cursorPosition = query.length) => {
    const innerText = query.substring(0, cursorPosition);
    // A text in another language ends the command: its options and the text are read apart.
    const [body] = spec;

    if (body?.kind === 'slot' && body.role.kind === 'sublanguage') {
      return provideSublanguage({
        slot: body,
        query,
        cursorPosition,
        commandStart: command.location.min,
        callbacks,
        context,
      });
    }

    const { tokens, typed } = toTokens(innerText, command);
    const position = matchSpec(spec, tokens, options);
    const env: Environment = {
      spec,
      query,
      cursorPosition,
      command,
      callbacks,
      context,
      position,
      tokens,
      typed,
    };
    // A column typed in full, where a column can stand: what follows it is offered with it.
    const takesColumn = position.expected.some(
      (expected) =>
        expected.kind === 'slot' &&
        (expected.slot.role.kind === 'column' || expected.slot.role.kind === 'expression')
    );

    const isInExpression = position.open?.slot.role.kind === 'expression';

    if (typed !== undefined && takesColumn && !isInExpression && context?.columns?.has(typed)) {
      const end = innerText.length;
      const word: SpecToken = { text: typed, start: end - typed.length, end };
      const after = matchSpec(spec, [...tokens, word], options);
      const followers = after.expected
        .filter(({ kind }) => kind !== 'slot')
        .flatMap((expected) => provideExpected(expected, spec));

      if (!after.isInvalid && followers.length) {
        return followers.map((item) =>
          item.text === '\n'
            ? item
            : {
                ...item,
                text: `${typed}${item.text.startsWith(',') ? '' : ' '}${item.text}`,
                filterText: typed,
              }
        );
      }
    }

    const last = position.filled.at(-1);
    const isAfterLast = last !== undefined && last.end === tokens.at(-1)?.end;

    if (position.isInvalid) {
      return [];
    }
    // A qualifier is written and its name is not: the name comes right after it, or nothing.
    const hasQualifiers =
      last?.slot.role.kind === 'entity' &&
      (ENTITY_FACTS[last.slot.role.entityType].qualifiers?.length ?? 0) > 0;

    if (isAfterLast && hasQualifiers && last.text.endsWith(QUALIFIER_JOINER)) {
      return last.end === innerText.length ? provideSlot(last.slot, env) : [];
    }
    // A name that is not one of the things expected there can only be a new name: the symbol
    // that assigns it is all that can follow.
    if (isAfterLast && typed === undefined && !isKnown(last, env)) {
      const [, mark] = getAssignmentBefore(spec, last.slot) ?? [];

      if (mark?.kind === 'symbol') {
        return provideExpected({ kind: 'symbol', text: mark.text }, spec);
      }
    }
    // Inside an expression, or right after one, the expression says what comes next: its
    // operators, and what follows it once it is whole.
    const { open } = position;
    const lastToken = tokens.at(-1)?.text;

    // Inside a pipeline in brackets: its commands at its start and after a pipe, and inside
    // one of its commands, what that command offers.
    if (position.branchStart !== undefined) {
      const { branchStart } = position;
      const inner = Walker.findAll(
        command,
        (node) => node.type === 'command' && node !== command && node.location.min > branchStart
      ) as ESQLAstAllCommands[];
      const current = inner.at(-1);
      // The bracket of the pipeline itself, or a pipe: a command starts here.
      const isAtCommandStart = tokens.at(-1)?.start === branchStart || lastToken === '|';

      if (!current || isAtCommandStart) {
        return getCommandAutocompleteDefinitions(
          esqlCommandRegistry.getProcessingCommandNames().filter((name) => name !== command.name)
        );
      }

      return (
        (await esqlCommandRegistry
          .getCommandMethods(current.name)
          ?.autocomplete(innerText, current, callbacks, context, cursorPosition)) ?? []
      );
    }
    // A list of entities knows what follows its names: the sources, with what the editor adds.
    if (open && open.slot.role.kind === 'entity') {
      return provideSlot(open.slot, env);
    }

    // A map that is closed, or a list after one of its names: what the spec allows next.
    if (open && open.slot.role.kind !== 'expression' && typed === undefined) {
      const braces = (text: string) => (open.text.match(new RegExp(`\\${text}`, 'g')) ?? []).length;
      const isClosedMap = open.slot.role.kind === 'map' && braces('{') === braces('}');
      const isAfterName = open.slot.role.kind !== 'map' && lastToken !== ',';

      if (isClosedMap || isAfterName) {
        return [
          ...(isAfterName ? provideExpected({ kind: 'symbol', text: ',' }, spec) : []),
          ...position.expected.flatMap((expected) => provideExpected(expected, spec)),
        ];
      }
    }
    if (open && open.slot.role.kind !== 'expression') {
      return provideSlot(open.slot, env);
    }
    if (position.open?.slot.role.kind === 'expression') {
      return provideSlot(position.open.slot, env);
    }

    const items = await Promise.all(
      position.expected.map(async (expected) => {
        if (expected.kind !== 'slot') {
          return provideExpected(expected, spec);
        }

        // A word that starts a qualifier is one: the names come after it.
        const qualifiers = provideQualifiers(expected.slot, typed);

        return qualifiers.length ? qualifiers : provideSlot(expected.slot, env);
      })
    );

    return items.flat();
  };
