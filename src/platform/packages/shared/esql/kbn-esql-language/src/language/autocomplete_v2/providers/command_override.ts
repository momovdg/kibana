/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Walker } from '@elastic/esql';
import type { ESQLColumn } from '@elastic/esql/types';
import { getUnmappedFieldsStrategy } from '../../../commands/definitions/utils/settings';
import type { ICommandContext, ISuggestionItem } from '../../../commands/registry/types';
import { getCommandContext } from '../../autocomplete/get_command_context';
import { getQueryForFields } from '../../shared/get_query_for_fields';
import { getColumnsByTypeRetriever } from '../../shared/columns_retrieval_helpers';
import { getAutocompleteCursorContext } from '../../shared/parse_for_autocomplete_query';
import { getRegisteredCommand } from '../command_metadata';
import { PROVIDER_OVERRIDES } from '../overrides';
import type { SuggestionContext } from '../types';

/** The rule of a command, read from one of its places: `rule>called` or `rule.label`. */
const commandOf = (place: string): string => place.split(/[.>]/)[0];

/**
 * Whether the command at the cursor is one whose suggestions are not the engine's yet: one
 * of its places has an override. The engine cannot read such a command from the grammar, so
 * the command is asked as a whole.
 */
export const isOverridden = ({ ir }: Pick<SuggestionContext, 'ir'>): boolean =>
  ir.command !== undefined &&
  Object.keys(PROVIDER_OVERRIDES).some((place) => commandOf(place) === ir.command);

/**
 * The suggestions of a command that provides its own: the autocomplete it registered is
 * called with what it expects, the tree of the command and the columns it can read. The
 * engine adds nothing and knows nothing about the command.
 */
export const provideOverride = async (context: SuggestionContext): Promise<ISuggestionItem[]> => {
  const { ir, text, offset, callbacks } = context;
  const registered = ir.command === undefined ? undefined : getRegisteredCommand(ir.command);
  const { root, astContext } = getAutocompleteCursorContext(text, offset);

  if (!registered || astContext.type !== 'expression') {
    return [];
  }

  const { command, isCursorInSubquery } = astContext;
  const innerText = text.slice(0, offset);
  // The columns such a command reads are not those of the commands before it: the helper the
  // commands share works them out from the command itself.
  const completedHeader = root.header?.filter(({ location }) => location.max < offset);
  const { getColumnsByType, getColumnMap } = getColumnsByTypeRetriever(
    getQueryForFields(innerText, { ...astContext.astForContext, header: completedHeader }),
    innerText,
    callbacks
  );
  const canBrowseFields = (await callbacks?.canSuggestResourceBrowser?.()) ?? false;
  const commandContext: ICommandContext = {
    columns: await getColumnMap(),
    ...(await getCommandContext(command, innerText, callbacks)),
    activeProduct: context.activeProduct,
    isCursorInSubquery,
    isFieldsBrowserEnabled: canBrowseFields && !isCursorInSubquery,
    unmappedFieldsStrategy: getUnmappedFieldsStrategy(root.header),
    isTimeseriesSource: context.sourceIsTimeSeries,
  };
  const getColumnsFor = callbacks?.getColumnsFor;

  return registered.methods.autocomplete(
    text,
    command,
    {
      getByType: (type, ignored, options) =>
        getColumnsByType(type, ignored, {
          ...options,
          isFieldsBrowserEnabled: commandContext.isFieldsBrowserEnabled,
        }),
      getSuggestedUserDefinedColumnName: () => {
        const used = new Set(
          Walker.findAll(root, (node) => node.type === 'column').map((column) =>
            (column as ESQLColumn).parts.join('.')
          )
        );
        let index = 0;
        while (used.has(`col${index}`)) {
          index++;
        }

        return `col${index}`;
      },
      getColumnsForQuery: getColumnsFor && (async (query: string) => getColumnsFor({ query })),
      hasMinimumLicenseRequired: context.hasLicense,
      getKqlSuggestions: callbacks?.getKqlSuggestions,
      canCreateLookupIndex: callbacks?.canCreateLookupIndex,
      canSuggestResourceBrowser: callbacks?.canSuggestResourceBrowser,
      isServerless: callbacks?.isServerless,
    },
    commandContext,
    offset
  );
};
