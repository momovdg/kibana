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
import {
  isAssignment,
  isColumn,
  isMap,
  isOptionNode,
  isSource,
  isStringLiteral,
  Walker,
} from '@elastic/esql';
import type {
  ESQLAstItem,
  ESQLAstNode,
  ESQLCommandOption,
  ESQLMap,
  ESQLSingleAstItem,
} from '@elastic/esql/types';
import type { MapParameter } from '../../../esql_js_prototype';
import { suggestForExpression } from '../../definitions/utils';
import { getAssignmentExpressionRoot } from '../../definitions/utils/expressions';
import {
  buildUserDefinedColumnsDefinitions,
  createInferenceEndpointToCompletionItem,
  withAutoSuggest,
} from '../../definitions/utils/autocomplete/helpers';
import { SuggestionCategory } from '../../../language/autocomplete/utils/sorting/types';
import {
  getCommandMapExpressionSuggestions,
  type MapParameters,
} from '../../definitions/utils/autocomplete/map_expression';
import type { PreferredExpressionType } from '../../definitions/utils/autocomplete/expressions/types';
import { getCommandOutput } from '../../definitions/utils/columns';
import { buildFieldsDefinitions } from '../../definitions/utils/functions';
import { buildConstantsDefinitions } from '../../definitions/utils/literals';
import {
  getMapEntryByStringKeyFromAst,
  getMapStringListValuesFromAst,
} from '../../definitions/utils/maps';
import { matchesWildcardPattern } from '../../definitions/utils/regex';
import type { Commands } from '../../definitions/keywords';
import { buildMapValueCompleteItem, getNewUserDefinedColumnSuggestion } from '../complete_items';
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
import { Location, type ESQLPolicy, type GetColumnsByTypeFn, type ISuggestionItem } from '../types';
import type { ExpressionSpec, SlotDefinition, SlotProvider, SuggestContext } from './types';

type ColumnsOptions = Parameters<GetColumnsByTypeFn>[2];

/** The arguments of the option the cursor is in, as LIMIT's `BY`, or else of the command. */
const argsAtCursor = (ctx: SuggestContext): ESQLAstItem[] =>
  optionAtCursor(ctx)?.args ?? ctx.command.args;

/** The last option starting before the cursor, as LIMIT's `BY`; the cursor may be past its end. */
const optionAtCursor = ({
  command,
  cursorPosition,
}: SuggestContext): ESQLCommandOption | undefined => {
  for (let index = command.args.length - 1; index >= 0; index--) {
    const arg = command.args[index];
    if (!Array.isArray(arg) && isOptionNode(arg) && arg.location.min < cursorPosition) {
      return arg;
    }
  }
  return undefined;
};

/**
 * The columns that are already whole items of the command's list before the word being typed,
 * e.g. `a` and `b` in `SORT a ASC, b, `; they are not suggested again.
 */
export const listedColumns = (ctx: SuggestContext): string[] => {
  const end = ctx.location.partial?.start ?? ctx.cursorPosition;
  const names: string[] = [];
  for (const arg of argsAtCursor(ctx)) {
    const item = !Array.isArray(arg) && arg.type === 'order' ? arg.args[0] : arg;
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
    ignored = listedColumns,
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
};

/** How an option is inserted when more than `name = ` helps, e.g. DENSE_VECTOR's suffix clause. */
const OPTION_SNIPPETS: Readonly<Record<string, { label: string; text: string }>> = {
  suffix: { label: 'suffix = "..." ON', text: 'suffix = "${1:_dense_vector}" ON $0' },
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
            category: SuggestionCategory.LANGUAGE_KEYWORD,
          }
        : withAutoSuggest({ label: name, text: `${name} = `, kind: 'Reference', detail });
    });

/** A new column name, e.g. `col0 = `. */
export const newName =
  (): SlotProvider =>
  async ({ callbacks }) =>
    [getNewUserDefinedColumnSuggestion(callbacks?.getSuggestedUserDefinedColumnName?.() || '')];

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
const findExpressionRoot = (ctx: SuggestContext): ESQLSingleAstItem | undefined => {
  const { cursorPosition, location } = ctx;
  // A comma between a function's arguments keeps the function as the root. A function name's
  // own `functionExpression` is its direct parent, not a call around it.
  const afterListComma =
    location.previousTokenType === getTokenType('COMMA') &&
    !location.expectedRules.some(({ stack }) => stack.slice(0, -1).includes('functionExpression'));
  if (afterListComma || location.expectedRules.some(startsCommandArgument)) {
    return undefined;
  }

  const args = argsAtCursor(ctx);
  for (let index = args.length - 1; index >= 0; index--) {
    const arg = args[index];
    if (Array.isArray(arg) || arg.type === 'option' || arg.location.min >= cursorPosition) {
      continue;
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
  { types, valuesControl = false }: { types?: string[]; valuesControl?: boolean } = {}
): Promise<ISuggestionItem[]> => {
  const { query, command, cursorPosition, context, callbacks } = ctx;
  const resolvedOptions = typeof options === 'function' ? options(ctx) : options;
  const { suggestions } = await suggestForExpression({
    query,
    expressionRoot: getRoot(ctx),
    command,
    cursorPosition,
    // Derived from the command and option, as validation does; inside the option even when the
    // cursor is past its end, as after `LIMIT 10 BY a, `. A command with no location of its own
    // takes the scalar functions, as EVAL does.
    location:
      location ??
      getLocationInfo(
        Math.min(cursorPosition, optionAtCursor(ctx)?.location.max ?? cursorPosition),
        command,
        Boolean(context?.isTimeseriesSource),
        false
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
    },
  });

  return suggestions;
};

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
      toMapParameters(rule, parameters, ctx)
    );
  };
