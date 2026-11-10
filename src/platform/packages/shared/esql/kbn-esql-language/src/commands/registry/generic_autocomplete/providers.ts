/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { i18n } from '@kbn/i18n';
import { ESQLVariableType } from '@kbn/esql-types';
import type { ESQLFieldWithMetadata } from '@kbn/esql-types';
import {
  isAssignment,
  isUnknownNode,
  isWhereExpression,
  isBinaryExpression,
  isColumn,
  isIdentifier,
  isMap,
  isOptionNode,
  isSource,
  isStringLiteral,
  Walker,
} from '@elastic/esql';
import type {
  ESQLAstAllCommands,
  ESQLAstItem,
  ESQLAstJoinCommand,
  ESQLAstNode,
  ESQLCommandOption,
  ESQLMap,
  ESQLSingleAstItem,
} from '@elastic/esql/types';
import {
  getCallSites,
  getLabelledArgumentRole,
  type MapParameter,
} from '../../../esql_js_prototype';
import { suggestForExpression } from '../../definitions/utils';
import { getAssignmentExpressionRoot } from '../../definitions/utils/expressions';
import {
  buildUserDefinedColumnsDefinitions,
  columnExists,
  createInferenceEndpointToCompletionItem,
  getLookupIndexCreateSuggestion,
  withAutoSuggest,
} from '../../definitions/utils/autocomplete/helpers';
import { SuggestionCategory } from '../../../language/autocomplete/utils/sorting/types';
import {
  getCommandMapExpressionSuggestions,
  type MapParameters,
} from '../../definitions/utils/autocomplete/map_expression';
import type {
  PreferredExpressionType,
  SuggestForExpressionResult,
} from '../../definitions/utils/autocomplete/expressions/types';
import { getCommandOutput } from '../../definitions/utils/columns';
import { buildFieldsDefinitions } from '../../definitions/utils/functions';
import { buildConstantsDefinitions } from '../../definitions/utils/literals';
import {
  getMapEntryByStringKeyFromAst,
  getMapStringListValuesFromAst,
} from '../../definitions/utils/maps';
import { matchesWildcardPattern } from '../../definitions/utils/regex';
import type { Commands } from '../../definitions/keywords';
import {
  assignCompletionItem,
  buildMapValueCompleteItem,
  getNewUserDefinedColumnSuggestion,
} from '../complete_items';
import {
  buildMatchingFieldsDefinition,
  buildPoliciesDefinitions,
  getPolicyNameRange,
  modeSuggestions,
  noPoliciesAvailableSuggestion,
} from '../enrich/util';
import { getTokenType } from '../../../language/shared/cursor_location/cursor_location';
import type { ExpectedRule } from '../../../language/shared/cursor_location/types';
import { isExpressionSlot } from './slot_matching';
import { getLocationInfo } from '../location';
import { FULL_TEXT_SEARCH_DEFINITIONS } from '../../definitions/constants';
import { specialIndicesToSuggestions } from '../../definitions/utils/sources';
import { getIndicesBrowserSuggestion } from '../../definitions/utils/autocomplete/resource_browser_suggestions';
import { getAvailableMetadataFields } from '../options/metadata';
import { getRecommendedQueriesSuggestions } from '../options/recommended_queries';
import { createEnrichedContext, createEnrichedGetByType } from '../join/utils';
import { getAggregationScope, getStatsFunctionsToIgnore } from '../stats/utils';
import { isAggFunctionUsedAlready } from '../../definitions/utils/autocomplete/functions';
import { getSettingsCompletionItems } from '../../definitions/utils/settings';
import { getSettingMapParameters, getSettingValueItems } from '../set/utils';
import { ReplacementRangeStrategyKind } from '../../../language/autocomplete/utils/prefix_range';
import { Location, type ESQLPolicy, type GetColumnsByTypeFn, type ISuggestionItem } from '../types';
import type { ExpressionSpec, SlotDefinition, SlotProvider, SuggestContext } from './types';

type ColumnsOptions = Parameters<GetColumnsByTypeFn>[2];

/** The arguments of the option the cursor is in, as LIMIT's `BY`, or else of the command. */
const argsAtCursor = (ctx: SuggestContext): ESQLAstItem[] =>
  optionAtCursor(ctx)?.args ?? ctx.command.args;

/**
 * The last option starting before the cursor, as LIMIT's `BY`; the cursor may be past its end.
 * An option the parser made up for a missing keyword, as MMR's `ON`, starts nowhere (-1).
 */
const optionAtCursor = ({
  command,
  cursorPosition,
}: SuggestContext): ESQLCommandOption | undefined => {
  for (let index = command.args.length - 1; index >= 0; index--) {
    const arg = command.args[index];
    if (
      !Array.isArray(arg) &&
      isOptionNode(arg) &&
      arg.location.min >= 0 &&
      arg.location.min < cursorPosition
    ) {
      return arg;
    }
  }
  return undefined;
};

/**
 * The columns that are already whole items of the command's list before the word being typed,
 * e.g. `a` and `b` in `SORT a ASC, b, `; they are not suggested again. In a list of columns, an
 * assignment's column counts too, as `message` in `DENSE_VECTOR vec = message, `; expressions
 * may use it again.
 */
export const listedColumns = (
  ctx: SuggestContext,
  { assignedColumns = false }: { assignedColumns?: boolean } = {}
): string[] => {
  const end = ctx.location.partial?.start ?? ctx.cursorPosition;
  const names: string[] = [];
  for (const arg of argsAtCursor(ctx)) {
    const listed = !Array.isArray(arg) && arg.type === 'order' ? arg.args[0] : arg;
    const item =
      assignedColumns && !Array.isArray(listed) && isAssignment(listed)
        ? getAssignmentExpressionRoot(listed)
        : listed;
    if (isColumn(item) && item.location.max < end) {
      names.push(item.parts.join('.'));
    }
  }
  return names;
};

/** A double-quoted string is being typed, as in `GROK "a`: never a column, which backticks quote. */
const isTypingString = ({ location }: SuggestContext): boolean =>
  Boolean(location.partial?.text.startsWith('"'));

/**
 * The existing columns of `types` (any by default), through `callbacks.getByType`, without
 * those already listed.
 */
export const columns =
  ({
    types = 'any',
    ignored = (ctx) => listedColumns(ctx, { assignedColumns: true }),
    options,
  }: {
    types?: string | string[];
    ignored?: (ctx: SuggestContext) => string[];
    options?: ColumnsOptions;
  } = {}): SlotProvider =>
  async (ctx) =>
    isTypingString(ctx)
      ? []
      : (await ctx.callbacks?.getByType?.(types, ignored(ctx), options)) ?? [];

/** Constant values to start from, e.g. `10`, `100`, `1000` for a row count. */
export const constants =
  (values: string[], detail = ''): SlotProvider =>
  async () =>
    buildConstantsDefinitions(values, detail, { advanceCursorAndOpenSuggestions: true });

/** The same items at every position, e.g. `":"` and `";"` for a separator. */
export const fixed =
  (items: ISuggestionItem[]): SlotProvider =>
  async () =>
    items;

const OPTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  APPEND_SEPARATOR: i18n.translate('esqlLanguage.esql.definitions.appendSeparatorDoc', {
    defaultMessage:
      'The character(s) that separate the appended fields. Default to empty string ("").',
  }),
  suffix: i18n.translate('esqlLanguage.commands.denseVector.autocomplete.suffixModifierDetail', {
    defaultMessage: 'Custom suffix for the generated columns (default: _dense_vector)',
  }),
  prefix: i18n.translate('esqlLanguage.commands.highlight.autocomplete.prefixModifierDetail', {
    defaultMessage: 'Custom column name prefix (default: highlight_)',
  }),
};

/** How an option is inserted when more than `name = ` helps, e.g. DENSE_VECTOR's suffix clause. */
const OPTION_SNIPPETS: Readonly<Record<string, { label: string; text: string }>> = {
  suffix: { label: 'suffix = "..." ON', text: 'suffix = "${1:_dense_vector}" ON $0' },
  prefix: { label: 'prefix = "..."', text: 'prefix = "${0:highlight_}"' },
};

/** Option names with their `=`, e.g. `APPEND_SEPARATOR = `. */
export const optionNames =
  (names: string[]): SlotProvider =>
  async () =>
    names.map((name) => {
      const snippet = OPTION_SNIPPETS[name];
      const detail = OPTION_DESCRIPTIONS[name] ?? '';
      return snippet
        ? {
            ...snippet,
            kind: 'Keyword',
            detail,
            asSnippet: true,
            category: SuggestionCategory.COMMAND_MODIFIER,
          }
        : withAutoSuggest({ label: name, text: `${name} = `, kind: 'Reference', detail });
    });

const VALUE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'fuseCommand.fuseType.linear': i18n.translate('esqlLanguage.esql.autocomplete.fuse.linear', {
    defaultMessage: 'Linear combination of scores',
  }),
  'fuseCommand.fuseType.rrf': i18n.translate('esqlLanguage.esql.autocomplete.fuse.rrf', {
    defaultMessage: 'Reciprocal rank fusion',
  }),
};

/** Unquoted names from a fixed set, e.g. FUSE's methods, described by `argument.value`. */
export const identifiers =
  (argument: string, values: string[]): SlotProvider =>
  async () =>
    values.map((value) =>
      withAutoSuggest({
        label: value,
        text: `${value} `,
        kind: 'Value',
        detail: VALUE_DESCRIPTIONS[`${argument}.${value}`] ?? '',
        category: SuggestionCategory.VALUE,
      })
    );

/** A new column name, e.g. `col0 = `. */
export const newName =
  ({ whileTyped = false }: { whileTyped?: boolean } = {}): SlotProvider =>
  async ({ callbacks, context, location }) => {
    const suggested = getNewUserDefinedColumnSuggestion(
      callbacks?.getSuggestedUserDefinedColumnName?.() || ''
    );
    // A name being typed that is no column yet may start the assignment, keeping it: `b = `.
    const typed = location.partial?.text;
    const startsAssignment =
      whileTyped && typed !== undefined && !typed.startsWith('?') && !columnExists(typed, context);
    return startsAssignment
      ? [
          suggested,
          {
            ...assignCompletionItem,
            text: ` ${assignCompletionItem.text}`,
            preserveTypedPrefix: true,
          },
        ]
      : [suggested];
  };

const SUGGESTED_COLUMN_NAMES: Readonly<Record<string, string>> = {
  'changePointCommand.targetType': 'changePointType',
  'changePointCommand.targetPvalue': 'pValue',
};

/**
 * The name Kibana suggests for a new column at a labelled position, e.g. `changePointType` after
 * CHANGE_POINT's `AS`, with the comma when one must follow. Undefined where it suggests none.
 */
export const suggestedColumnName = (
  position: string,
  { comma }: { comma: boolean }
): SlotProvider | undefined => {
  const name = SUGGESTED_COLUMN_NAMES[position];
  if (!name) {
    return undefined;
  }
  return async () =>
    buildUserDefinedColumnsDefinitions([name]).map((item) =>
      withAutoSuggest({ ...item, text: comma ? `${item.text}, ` : item.text })
    );
};

/** A quoted string to fill in, e.g. `"Your search query"`, selected on insertion. */
export const stringSnippet = (text: string): ISuggestionItem => ({
  ...buildConstantsDefinitions(
    [`"$\{0:${text}}"`],
    '',
    undefined,
    undefined,
    SuggestionCategory.CONSTANT_VALUE
  )[0],
  label: text,
  asSnippet: true,
});

const allColumnsDetail = () =>
  i18n.translate('esqlLanguage.commands.highlight.autocomplete.allFieldsDetail', {
    defaultMessage: 'All text and keyword fields',
  });

/** `*` for every column of the role, where it may stand alone: as the list's first entry. */
export const wildcard = (): SlotProvider => async (_ctx, slot) =>
  slot.previousTokenType === getTokenType('COMMA')
    ? []
    : [
        withAutoSuggest({
          label: '*',
          text: '*',
          kind: 'Value',
          detail: allColumnsDetail(),
          // Listed before the columns, which are sorted alphabetically in their own category.
          category: SuggestionCategory.RECOMMENDED_FIELD,
        }),
      ];

/** Nothing: the user types the value freely. */
export const none = (): SlotProvider => async () => [];

/** Several providers at one slot, e.g. an existing column or a new name. */
export const merged =
  (...providers: SlotProvider[]): SlotProvider =>
  async (ctx, slot) =>
    (await Promise.all(providers.map((provide) => provide(ctx, slot)))).flat();

/**
 * Enrich policy names. A word starting with `_` and no `:` is a mode prefix; after `_mode:`
 * the policy replaces only the text after the colon.
 */
export const policies =
  (): SlotProvider =>
  async ({ context, location }) => {
    const { partial } = location;
    if (partial?.text.startsWith('_') && !partial.text.includes(':')) {
      return modeSuggestions;
    }

    const items = buildPoliciesDefinitions([...(context?.policies?.values() ?? [])]);
    if (!items.length) {
      return [noPoliciesAvailableSuggestion];
    }

    const rangeToReplace = getPolicyNameRange(location);
    return rangeToReplace ? items.map((item) => ({ ...item, rangeToReplace })) : items;
  };

/**
 * Lookup indices and their aliases, and an item to create the index typed when it is new and
 * the user may create it. A qualifier such as `_coordinator:` is a token of its own, not part
 * of the name typed.
 */
export const lookupIndices =
  (): SlotProvider =>
  async ({ context, callbacks, location }) => {
    const name = location.partial?.text ?? '';
    const sources = context?.joinSources ?? [];
    const exists = sources.some((source) => source.name === name || source.aliases.includes(name));
    const canCreate = !exists && ((await callbacks?.canCreateLookupIndex?.(name)) ?? false);
    return [
      ...(canCreate ? [getLookupIndexCreateSuggestion(name)] : []),
      ...specialIndicesToSuggestions(sources),
    ];
  };

/** The sources the command already names, before the one being typed. */
const usedSourceNames = ({ command, location, cursorPosition }: SuggestContext): Set<string> => {
  const end = location.partial?.start ?? cursorPosition;
  return new Set(
    command.args.flatMap((arg) =>
      !Array.isArray(arg) && isSource(arg) && arg.name && arg.location.max < end ? [arg.name] : []
    )
  );
};

/**
 * The sources a command reads, for the index mode its argument list requires: for TS's
 * `time_series`, time-series indices and their aliases. Names already used are left out. At an
 * empty position, "Browse data sources" comes first (only in the main query, which the item
 * itself checks). Inside a quoted name nothing fits.
 */
export const sources =
  ({ indexMode }: { indexMode?: string }): SlotProvider =>
  async (ctx, slot) => {
    const { location, context, callbacks } = ctx;
    // FROM's catalogs come with its migration (wave 5c).
    if (location.partial?.text.startsWith('"') || indexMode !== 'time_series') {
      return [];
    }
    const used = usedSourceNames(ctx);
    const indices = (context?.timeSeriesSources ?? [])
      .filter(({ name }) => !used.has(name))
      .map((index) => ({ ...index, aliases: index.aliases?.filter((alias) => !used.has(alias)) }));
    const items = specialIndicesToSuggestions(indices);
    const browser =
      location.partial || slot.continuation
        ? undefined
        : await getIndicesBrowserSuggestion({ callbacks, context });
    return browser ? [browser, ...items] : items;
  };

/** The names of the sources of an index mode, with their aliases, to tell a complete name. */
export const getSourceNames = (
  { context }: SuggestContext,
  indexMode: string | undefined
): Set<string> | undefined =>
  indexMode === 'time_series'
    ? new Set(
        (context?.timeSeriesSources ?? []).flatMap(({ name, aliases = [] }) => [name, ...aliases])
      )
    : undefined;

/**
 * The queries recommended after a source: for TS, the editor extensions' (Kibana's own
 * templates count rows, which TS does not aggregate that way).
 */
export const recommendedQueries = async (
  { context }: SuggestContext,
  indexMode: string | undefined
): Promise<ISuggestionItem[]> =>
  indexMode === 'time_series'
    ? getRecommendedQueriesSuggestions(
        context?.editorExtensions ?? { recommendedFields: [], recommendedQueries: [] }
      )
    : [];

/** The METADATA fields the command does not list yet; serverless adds the project fields. */
export const remainingMetadataFields = ({ command, callbacks }: SuggestContext): string[] => {
  const used = new Set(
    command.args.flatMap((arg) =>
      !Array.isArray(arg) && isOptionNode(arg) && arg.name === 'metadata'
        ? arg.args.flatMap((field) =>
            !Array.isArray(field) && isColumn(field) ? [field.name] : []
          )
        : []
    )
  );
  return getAvailableMetadataFields(callbacks?.isServerless).filter((name) => !used.has(name));
};

/** METADATA fields, each offered once. */
export const metadataFields = async (ctx: SuggestContext): Promise<ISuggestionItem[]> =>
  buildFieldsDefinitions(remainingMetadataFields(ctx));

/**
 * The callbacks and context of an expression that also reads the columns of the command's
 * lookup index, as a JOIN condition.
 */
const withLookupColumns = async ({
  command,
  callbacks,
  context,
}: SuggestContext): Promise<Pick<SuggestContext, 'callbacks' | 'context'>> => {
  const join = command as ESQLAstJoinCommand;
  // `FROM <lookup index>` only returns index fields; this narrows the callback's column type.
  const getColumnsForQuery = async (query: string): Promise<ESQLFieldWithMetadata[]> => {
    const queryColumns = (await callbacks?.getColumnsForQuery?.(query)) ?? [];
    return queryColumns.filter((column): column is ESQLFieldWithMetadata => !column.userDefined);
  };
  const getByType = await createEnrichedGetByType(
    callbacks?.getByType ?? (() => Promise.resolve([])),
    join,
    getColumnsForQuery,
    context
  );
  return {
    callbacks: { ...callbacks, getByType },
    context: await createEnrichedContext(context, join, getColumnsForQuery),
  };
};

/** The settings SET can assign, without the serverless-only ones outside serverless. */
export const settingNames =
  (): SlotProvider =>
  async ({ callbacks }) =>
    getSettingsCompletionItems(callbacks?.isServerless);

/** The name of the setting SET assigns, once `=` is typed. */
const getSettingName = ({ command }: SuggestContext): string => {
  const [setting] = command.args;
  const name = !Array.isArray(setting) && isBinaryExpression(setting) ? setting.args[0] : undefined;
  return !Array.isArray(name) && isIdentifier(name) ? name.name : '';
};

/**
 * The value of the setting SET assigns: inside its map, the setting's parameters; inside an open
 * string, the values as its content; otherwise the values, strings quoted.
 */
export const settingValues = (): SlotProvider => async (ctx, slot) => {
  const { query, cursorPosition, location } = ctx;
  const name = getSettingName(ctx);
  if (slot.stack.includes('mapExpression')) {
    const parameters = getSettingMapParameters(name);
    return parameters
      ? getCommandMapExpressionSuggestions(query.slice(0, cursorPosition), parameters)
      : [];
  }

  const items = getSettingValueItems(name);
  const { partial } = location;
  if (partial?.text.startsWith('"')) {
    // The whole content replaces what is between the quotes, up to a closing one.
    const start = partial.start + 1;
    const closingQuote = query.indexOf('"', start);
    const scopeText = query.slice(start, closingQuote === -1 ? query.length : closingQuote);
    return items.map((item) => ({
      ...item,
      replacementRangeStrategy: {
        kind: ReplacementRangeStrategyKind.WHOLE_SCOPE,
        scopeText,
        startOffset: start,
      },
    }));
  }
  return items.map((item) =>
    item.category === SuggestionCategory.CONSTANT_VALUE ? { ...item, text: `"${item.text}"` } : item
  );
};

/** The enrich policy the command names, looked up without its `_mode:` prefix as validation does. */
export const getEnrichPolicy = ({ command, context }: SuggestContext): ESQLPolicy | undefined => {
  const source = command.args.find((arg) => isSource(arg));
  if (!isSource(source)) {
    return undefined;
  }
  return context?.policies?.get(source.index?.valueUnquoted ?? source.name);
};

/** The enrich fields of the command's policy. */
export const enrichFields = (): SlotProvider => async (ctx) => {
  const policy = getEnrichPolicy(ctx);
  return policy ? buildFieldsDefinitions(policy.enrichFields, false) : [];
};

/** The columns to match on the command's policy's match field. */
export const matchingColumns = (): SlotProvider => async (ctx) => {
  const policy = getEnrichPolicy(ctx);
  if (!policy) {
    return [];
  }
  const names = [...(ctx.context?.columns.values() ?? [])]
    .filter(({ userDefined }) => !userDefined)
    .map(({ name }) => name);
  return buildMatchingFieldsDefinition(policy.matchField, names);
};

/** Rules whose items are separated by commas, so a comma may directly follow a column. */
const LIST_RULES = ['qualifiedNamePatterns'];

/**
 * Columns for a slot no role describes. The suggestions reopen after one, and the cursor moves
 * on unless the column is a list item, where a comma may follow: `MV_EXPAND a ` but `KEEP a`.
 */
const defaultColumns = (): SlotProvider => async (ctx, slot) => {
  const inList = LIST_RULES.includes(slot.stack[slot.stack.length - 1] ?? '');
  return columns({ options: { openSuggestions: true, ...(!inList && { advanceCursor: true }) } })(
    ctx,
    slot
  );
};

export const DEFAULT_SLOTS: readonly SlotDefinition[] = [
  { rule: 'qualifiedName', provide: defaultColumns() },
  { rule: 'qualifiedNamePattern', provide: defaultColumns() },
  { rule: 'enrichPolicyName', provide: policies() },
];

/**
 * An expression slot the cursor starts that also starts a whole argument of the command, as
 * after `USER_AGENT ua = `: the expression is still empty.
 */
const startsCommandArgument = (slot: ExpectedRule): boolean =>
  !slot.continuation &&
  isExpressionSlot(slot) &&
  Boolean(slot.stack[slot.stack.length - 1 - slot.startsRules]?.endsWith('Command'));

/**
 * The last argument starting before the cursor, unless the cursor starts a new one: right
 * after a comma of the command's list, or while a word is typed after one (`SORT a, b` or an
 * unterminated `SORT a, `b`), or at the start of an argument (`USER_AGENT ua = `, where `ua`
 * is not part of it).
 */
/**
 * The cursor is in an aggregation's filter, past the aggregation of STATS's `MIN(b) WHERE `,
 * where the filter's functions apply even while it is empty.
 */
const isInAggregationFilter = ({ command, cursorPosition, location }: SuggestContext): boolean => {
  const arg = command.args.findLast(
    (candidate) => !Array.isArray(candidate) && candidate.location.min < cursorPosition
  );
  if (!arg || Array.isArray(arg) || !isWhereExpression(arg)) {
    return false;
  }
  // A comma after the filter starts the next aggregation.
  if (location.previousTokenType === getTokenType('COMMA') && cursorPosition > arg.location.max) {
    return false;
  }
  const [aggregation] = arg.args;
  return !Array.isArray(aggregation) && cursorPosition > aggregation.location.max + 1;
};

/** Rules whose own lists are part of an expression: function arguments and `IN (…)`. */
const EXPRESSION_LIST_RULES = ['functionExpression', 'booleanExpression'];

/**
 * The slot follows a comma of an expression's list, as a function's next argument or the next
 * value of `a IN (b, `, rather than one of the command's lists. The calls the parser made tell
 * them apart: `booleanExpression` calls a value after a comma only in `IN (…)`.
 */
export const isInExpressionList = ({ rule, stack, invokingStates }: ExpectedRule): boolean => {
  for (let index = stack.length; index > 0; index--) {
    const state = invokingStates?.[index];
    const child = index === stack.length ? rule : stack[index];
    const site = getCallSites(stack[index - 1], child).find(
      (candidate) => candidate.state === state
    );
    if (site?.precededBy.includes('COMMA')) {
      return EXPRESSION_LIST_RULES.includes(stack[index - 1]);
    }
  }
  return false;
};

const findExpressionRoot = (ctx: SuggestContext): ESQLSingleAstItem | undefined => {
  const { cursorPosition, location } = ctx;
  // A comma between a function's arguments or in an `IN (…)` list keeps the expression as the
  // root; one of the command's own lists starts a new item.
  const afterListComma =
    location.previousTokenType === getTokenType('COMMA') &&
    !location.expectedRules.some(isInExpressionList);
  if (afterListComma || location.expectedRules.some(startsCommandArgument)) {
    return undefined;
  }

  const args = argsAtCursor(ctx);
  for (let index = args.length - 1; index >= 0; index--) {
    const arg = args[index];
    if (Array.isArray(arg) || arg.type === 'option' || arg.location.min >= cursorPosition) {
      continue;
    }
    // An aggregation's filter, as STATS's `MIN(b) WHERE c`: after the aggregation the
    // condition, none while it is empty; within it the aggregation.
    if (isWhereExpression(arg)) {
      const [aggregation, condition] = arg.args;
      if (!Array.isArray(aggregation) && cursorPosition <= aggregation.location.max + 1) {
        return isAssignment(aggregation) ? getAssignmentExpressionRoot(aggregation) : aggregation;
      }
      return !condition || Array.isArray(condition) || isUnknownNode(condition)
        ? undefined
        : condition;
    }
    // The expression of an assignment (`geo = ipField`) or of `ORDER`, not the whole.
    if (isAssignment(arg)) {
      return getAssignmentExpressionRoot(arg);
    }
    if (arg.type !== 'order') {
      return arg;
    }
    const [expression] = arg.args;
    return Array.isArray(expression) ? undefined : expression;
  }
  return undefined;
};

/**
 * The engine's defaults, plus a space and reopened suggestions after an operator's operand. A
 * new list item leaves out the columns already listed; inside a function they stay.
 */
const defaultExpressionOptions = (ctx: SuggestContext) => ({
  addSpaceAfterOperator: true,
  openSuggestions: true,
  ignoredColumnsForEmptyExpression: findExpressionRoot(ctx) ? [] : listedColumns(ctx),
});

/**
 * One expression-engine call for the expression at the cursor, preferring `types` when the
 * argument's role gives them, e.g. a string for USER_AGENT's input.
 */
export const suggestExpression = async (
  ctx: SuggestContext,
  {
    location,
    options = defaultExpressionOptions,
    getRoot = findExpressionRoot,
  }: ExpressionSpec = {},
  {
    types,
    valuesControl = false,
    noColumns = false,
    lookupColumns = false,
    subqueries = false,
    fullTextOnlyIn,
    constantArgument = false,
    aggregation = false,
    inAggregations = false,
    inGroupings = false,
    grouping = false,
    inAggregationCall = false,
  }: {
    types?: string[];
    valuesControl?: boolean;
    noColumns?: boolean;
    lookupColumns?: boolean;
    subqueries?: boolean;
    fullTextOnlyIn?: string;
    constantArgument?: boolean;
    aggregation?: boolean;
    inAggregations?: boolean;
    inGroupings?: boolean;
    grouping?: boolean;
    inAggregationCall?: boolean;
  } = {}
): Promise<SuggestForExpressionResult> => {
  const { query, command, cursorPosition } = ctx;
  // The aggregations read the columns the groupings define, as `STATS AVG(b) BY b = a`.
  const scoped = lookupColumns
    ? await withLookupColumns(ctx)
    : inAggregations
    ? getAggregationScope(query, cursorPosition, command, ctx.context, ctx.callbacks)
    : ctx;
  const { context } = scoped;
  // A constant reads no column, also as a function's argument; an aggregation reads none outside
  // its function calls, as after `MIN(a) + `.
  const callbacks =
    constantArgument || aggregation
      ? { ...scoped.callbacks, getByType: async () => [] }
      : scoped.callbacks;
  const resolvedOptions = typeof options === 'function' ? options(ctx) : options;
  const { suggestions, computed } = await suggestForExpression({
    query,
    expressionRoot: getRoot(ctx),
    command,
    cursorPosition,
    // Derived from the command and option, as validation does; inside the option even when the
    // cursor is past its end, as after `LIMIT 10 BY a, `. A command with no location of its own
    // takes the scalar functions, as EVAL does.
    location:
      location ??
      (isInAggregationFilter(ctx) ? Location.STATS_WHERE : undefined) ??
      getLocationInfo(
        Math.min(cursorPosition, optionAtCursor(ctx)?.location.max ?? cursorPosition),
        command,
        Boolean(context?.isTimeseriesSource),
        // Inside a call after an aggregation of a TS source, the time-series aggregations apply.
        inAggregationCall && isAggFunctionUsedAlready(command, command.args.length - 1)
      ).id ??
      Location.EVAL,
    context,
    callbacks,
    options: {
      ...resolvedOptions,
      // `unknown` keeps functions whose type depends on their arguments, as CASE.
      ...(types && {
        preferredExpressionType: [...types, 'unknown'] as PreferredExpressionType[],
      }),
      ...(valuesControl && { controlType: ESQLVariableType.VALUES }),
      ...((noColumns || aggregation) && { suggestFields: false }),
      // An aggregation starts with a function, which a control may stand for.
      ...(aggregation && !valuesControl && { controlType: ESQLVariableType.FUNCTIONS }),
      // Grouping columns are offered without a space: `BY host` is often followed by a comma.
      ...(inGroupings && { addSpaceAfterFirstField: false }),
      ...(subqueries && { allowSubquery: true }),
      ...((inAggregations || inGroupings) && {
        getFunctionsToIgnore: getStatsFunctionsToIgnore(command, cursorPosition),
      }),
      ...(fullTextOnlyIn && {
        getFunctionsToIgnore: () => ({
          names: [...FULL_TEXT_SEARCH_DEFINITIONS],
          allowedInsideFunctions: Object.fromEntries(
            FULL_TEXT_SEARCH_DEFINITIONS.map((name) => [name, [fullTextOnlyIn]])
          ),
        }),
      }),
    },
  });

  // `=` and `AS` are offered by location, as JOIN's; they fit only where the grammar expects them.
  return {
    suggestions: suggestions.filter(({ label }) => {
      const token = GRAMMAR_PLACED_OPERATORS[label.toLowerCase()];
      return !token || ctx.location.expectedTokens.has(getTokenType(token));
    }),
    computed,
  };
};

/** Operators the expression engine offers by location, with the token the grammar places. */
const GRAMMAR_PLACED_OPERATORS: Readonly<Record<string, string>> = { '=': 'ASSIGN', as: 'AS' };

const MAP_PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'userAgentCommand.regex_file': i18n.translate(
    'esqlLanguage.commands.userAgent.autocomplete.regexFileDescription',
    { defaultMessage: 'Parser configuration file name' }
  ),
  'userAgentCommand.extract_device_type': i18n.translate(
    'esqlLanguage.commands.userAgent.autocomplete.extractDeviceTypeDescription',
    { defaultMessage: 'Extract device type (Desktop, Phone, Tablet)' }
  ),
  'userAgentCommand.properties': i18n.translate(
    'esqlLanguage.commands.userAgent.autocomplete.propertiesDescription',
    { defaultMessage: 'List of properties to extract' }
  ),
  'ipLocationCommand.database_file': i18n.translate(
    'esqlLanguage.commands.ipLocation.autocomplete.databaseFileDescription',
    { defaultMessage: 'IP location database file name' }
  ),
  'ipLocationCommand.first_only': i18n.translate(
    'esqlLanguage.commands.ipLocation.autocomplete.firstOnlyDescription',
    { defaultMessage: 'Use only the first value from multi-value IP input' }
  ),
  'ipLocationCommand.properties': i18n.translate(
    'esqlLanguage.commands.ipLocation.autocomplete.propertiesDescription',
    { defaultMessage: 'List of properties to extract' }
  ),
  'denseVectorCommand.inference_id': i18n.translate(
    'esqlLanguage.commands.denseVector.autocomplete.inferenceIdDescription',
    {
      defaultMessage:
        'Inference endpoint used to generate the embeddings. For text the endpoint must be text_embedding or multimodal embedding; for image it must be multimodal embedding. Defaults to the built-in text embedding endpoint.',
    }
  ),
  'denseVectorCommand.type': i18n.translate(
    'esqlLanguage.commands.denseVector.autocomplete.typeDescription',
    {
      defaultMessage:
        'Input modality: "text" (default) embeds the field value as text; "image" expects a base64 data URI and requires a multimodal embedding endpoint.',
    }
  ),
  'denseVectorCommand.timeout': i18n.translate(
    'esqlLanguage.commands.denseVector.autocomplete.timeoutDescription',
    { defaultMessage: 'Maximum time to wait for each inference request (default: 30s)' }
  ),
  'highlightCommand.analyzer': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.analyzerDescription',
    { defaultMessage: 'Analyzer used to re-analyze the ON fields before highlighting' }
  ),
  'highlightCommand.pre_tags': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.preTagsDescription',
    {
      defaultMessage: 'HTML tag to insert before highlighted text (default: <em>)',
      ignoreTag: true,
    }
  ),
  'highlightCommand.post_tags': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.postTagsDescription',
    {
      defaultMessage: 'HTML tag to insert after highlighted text (default: </em>)',
      ignoreTag: true,
    }
  ),
  'highlightCommand.number_of_fragments': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.numberOfFragmentsDescription',
    { defaultMessage: 'Maximum number of fragments to return (default: 5)' }
  ),
  'highlightCommand.fragment_size': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.fragmentSizeDescription',
    { defaultMessage: 'Size of each fragment in characters (default: 100)' }
  ),
  'highlightCommand.encoder': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.encoderDescription',
    { defaultMessage: 'Encoding for highlighted text: default or html (default: default)' }
  ),
  'highlightCommand.boundary_scanner': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.boundaryScannerDescription',
    { defaultMessage: 'How to split fragments: sentence or word (default: sentence)' }
  ),
  'highlightCommand.boundary_scanner_locale': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.boundaryScannerLocaleDescription',
    { defaultMessage: 'Locale for boundary scanning (default: Locale.ROOT)' }
  ),
  'highlightCommand.order': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.orderDescription',
    { defaultMessage: 'Order of fragments: none or score (default: none)' }
  ),
  'highlightCommand.no_match_size': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.noMatchSizeDescription',
    {
      defaultMessage:
        'Minimum characters to return when there is no match, extended to the next boundary (default: 0)',
    }
  ),
  'highlightCommand.max_analyzed_offset': i18n.translate(
    'esqlLanguage.commands.highlight.autocomplete.maxAnalyzedOffsetDescription',
    { defaultMessage: 'Maximum character offset to analyze, or -1 to unset (default: -1)' }
  ),
  'mmrCommand.lambda': i18n.translate('esqlLanguage.commands.mmr.autocomplete.lambdaDescription', {
    defaultMessage: 'MMR lambda value',
  }),
};

/** The command's top-level `WITH { … }` map, which the cursor is in. */
const findCommandMap = ({ command, cursorPosition }: SuggestContext): ESQLMap | undefined =>
  Walker.findAll(command, (node) => isMap(node as ESQLAstNode))
    .filter((node): node is ESQLMap => isMap(node as ESQLAstNode))
    .find(({ location }) => location.min < cursorPosition);

const stringValueOf = (map: ESQLMap | undefined, name: string): string | undefined => {
  const entry = getMapEntryByStringKeyFromAst(map, name);
  return entry && isStringLiteral(entry.value) ? entry.value.valueUnquoted : undefined;
};

/**
 * The values of a list parameter the command's output definition selects its columns by, as
 * IP_LOCATION's `properties`: the columns of the output variant that the parameter it varies
 * by names (`database_file`, or its default), or of every variant when that is not a string.
 */
const outputColumnNames = (
  { command }: SuggestContext,
  name: string,
  parameters: Record<string, MapParameter>,
  map: ESQLMap | undefined
): string[] => {
  const output = getCommandOutput(command.name as Commands);
  if (!output || output.selected_by !== name) {
    return [];
  }
  const allNames = () =>
    [...new Set(Object.values(output.variants).flatMap((variant) => Object.keys(variant)))].sort();
  const { vary_by: varyBy } = output;
  if (getMapEntryByStringKeyFromAst(map, varyBy) && !stringValueOf(map, varyBy)) {
    return allNames();
  }
  const chosen = (stringValueOf(map, varyBy) ?? parameters[varyBy]?.default)?.toLowerCase();
  const variant = chosen
    ? Object.entries(output.variants).find(([pattern]) =>
        matchesWildcardPattern(pattern.toLowerCase(), chosen)
      )?.[1]
    : output.variants.all;
  return variant ? Object.keys(variant) : allNames();
};

const NUMERIC_MAP_TYPES = ['integer', 'long', 'double'];

/**
 * The value of a labelled argument, e.g. `fuseCommand.fuseType`: the name the command node
 * holds under the label, else the role's default.
 */
const labelledArgumentValue = (command: ESQLAstAllCommands, name: string): string | undefined => {
  const label = name.slice(name.indexOf('.') + 1);
  const node: unknown = Object.entries(command).find(([key]) => key === label)?.[1];
  if (node && typeof node === 'object' && 'name' in node && typeof node.name === 'string') {
    return node.name.toLowerCase();
  }
  const role = getLabelledArgumentRole(name);
  return role?.kind === 'constant' ? role.default : undefined;
};

/** The parameters that apply to the command as written, e.g. FUSE's `normalizer` for `linear`. */
const applicableParameters = (
  { command }: SuggestContext,
  parameters: Record<string, MapParameter>
): Record<string, MapParameter> =>
  Object.fromEntries(
    Object.entries(parameters).filter(([, { when = {} }]) =>
      Object.entries(when).every(([name, values]) => {
        const value = labelledArgumentValue(command, name);
        return value !== undefined && values.includes(value);
      })
    )
  );

/** How the map helper shows a parameter: its kind of value, description and example values. */
const toMapParameters = (
  rule: string,
  parameters: Record<string, MapParameter>,
  { context }: SuggestContext
): MapParameters =>
  Object.fromEntries(
    Object.entries(parameters).map(([name, parameter]) => {
      const description = MAP_PARAMETER_DESCRIPTIONS[`${rule}.${name}`];
      if (parameter.list) {
        return [
          name,
          { type: 'array', description, suggestions: [buildMapValueCompleteItem('[ $0 ]', '[]')] },
        ];
      }
      if (NUMERIC_MAP_TYPES.includes(parameter.type)) {
        const suggestions = parameter.default ? [buildMapValueCompleteItem(parameter.default)] : [];
        return [name, { type: 'number', description, suggestions }];
      }
      if (parameter.type === 'map') {
        return [name, { type: 'map', description }];
      }
      if (parameter.type === 'boolean') {
        const suggestions = ['true', 'false'].map((value) => buildMapValueCompleteItem(value));
        return [name, { type: 'boolean', description, suggestions }];
      }
      if (parameter.entityType === 'inference_endpoint') {
        const suggestions = (context?.inferenceEndpoints ?? []).map(
          createInferenceEndpointToCompletionItem
        );
        return [name, { type: 'string', description, suggestions }];
      }
      const values = parameter.values ?? (parameter.default ? [parameter.default] : []);
      return [
        name,
        {
          type: 'string',
          description,
          suggestions: values.map((value) => buildMapValueCompleteItem(value)),
        },
      ];
    })
  );

/**
 * The entries of a command's `WITH { … }` map: the parameters not set yet, the values of the
 * one being set, and inside a list the values not listed yet.
 */
export const mapEntries =
  (rule: string, parameters: Record<string, MapParameter>): SlotProvider =>
  async (ctx, slot) => {
    const { query, cursorPosition } = ctx;
    // A value that started before the cursor and continues is a list, as `["name", `.
    if (slot.continuation) {
      const map = findCommandMap(ctx);
      const key = map?.entries
        .filter((entry) => entry.key.location.min < cursorPosition)
        .pop()?.key;
      const name = key && isStringLiteral(key) ? key.valueUnquoted : undefined;
      const parameter = name ? parameters[name] : undefined;
      if (!name || !parameter?.list) {
        return [];
      }
      const listed = new Set(getMapStringListValuesFromAst(map, name) ?? []);
      const values = parameter.values ?? outputColumnNames(ctx, name, parameters, map);
      return values
        .filter((value) => !listed.has(value))
        .map((value) => buildMapValueCompleteItem(`"${value}"`));
    }

    return getCommandMapExpressionSuggestions(
      query.slice(0, cursorPosition),
      toMapParameters(rule, applicableParameters(ctx, parameters), ctx)
    );
  };
