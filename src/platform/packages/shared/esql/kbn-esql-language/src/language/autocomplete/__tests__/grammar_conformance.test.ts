/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Parser } from '@elastic/esql';
import { esqlCommandRegistry } from '../../../commands/registry';
import {
  EXPRESSION_ENGINE_TOKENS,
  getMappedKeywordTokens,
} from '../../../commands/registry/keyword_items';
import { locateCursor } from '../../shared/cursor_location/cursor_location';
import { PREFERRED_RULES } from '../../shared/cursor_location/grammar_rules';
import { getArgumentRole, getCalledRules, getCallSites } from '../../../esql_js_prototype';
import { DEFAULT_SLOTS } from '../../../commands/registry/generic_autocomplete/providers';
import { EXPRESSION_RULES } from '../../../commands/registry/generic_autocomplete/slot_matching';

/**
 * Checks autocomplete against the grammar, so an `@elastic/esql` upgrade that adds a keyword or
 * a command fails here, naming what to map, instead of showing up as missing suggestions.
 * Supporting it needn't block the upgrade: a line in one of the lists below, with why, is enough
 * until it is supported. Dev-only tokens (`DEV_`) never fail it.
 */

/** Keywords no item offers, with why. Each one here is a decision, not an oversight. */
const UNOFFERED_KEYWORDS: Readonly<Record<string, string>> = {
  USING: 'the lexer defines it, but no parser rule uses it',
  DEFAULT: 'only FILLNULL uses it, a dev-only command',
};

/** Command-name tokens spelled differently from the registered command they start. */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  // `LOOKUP JOIN`
  JOIN_LOOKUP: 'join',
  // The one-word spelling, parsed by the same rule as INLINE STATS.
  INLINESTATS: 'inline stats',
};

/** Commands of the grammar Kibana doesn't support yet, with why. */
const UNSUPPORTED_COMMANDS: Readonly<Record<string, string>> = {
  TS_COLLAPSE: 'not supported by Kibana yet; to add as a command (registry entry and roles)',
};

/**
 * Slots no provider fills, keyed by the call path from the command (`limitCommand > constant`),
 * with why. Each one here is a decision, not an oversight.
 */
const UNFILLED_SLOTS: Readonly<Record<string, string>> = {};

const { symbolicNames, literalNames } = Parser.create('').parser;

/** A token's fixed text in the grammar, as `limit`; none for names, values and whitespace. */
const fixedText = (type: number): string | undefined =>
  literalNames[type]?.replace(/^'|'$/g, '') || undefined;

/**
 * Tokens that start a command (in the header, as the source, or after a pipe), with the command
 * rule each starts, as `limitCommand` for `LIMIT`.
 */
const commandStarts = new Map(
  ['', 'FROM a | ', 'SET a = 1;\n'].flatMap((query) => {
    const { expectedTokens, tokenStacks } = locateCursor(query, query.length);
    return [...expectedTokens].map(
      (type) => [symbolicNames[type] ?? '', tokenStacks.get(type)?.rules.at(-1) ?? ''] as const
    );
  })
);
const commandTokens = new Set(commandStarts.keys());

/** Tokens dev builds of Elasticsearch only accept, not offered in Kibana. */
const isDevOnly = (name: string): boolean => name.startsWith('DEV_');

/** Keywords: tokens whose fixed text is a word, other than command names. */
const keywordTokens = symbolicNames.flatMap((name, type) => {
  const text = fixedText(type);
  return name && text && /^[A-Za-z_]+$/.test(text) && !commandTokens.has(name) && !isDevOnly(name)
    ? [name]
    : [];
});

const commandNames = esqlCommandRegistry.getAllCommandNames();

/** The registered command a command-name token starts, as `inline stats` for `INLINE`. */
const registeredCommandFor = (name: string): string | undefined => {
  const type = symbolicNames.indexOf(name);
  const word = COMMAND_ALIASES[name] ?? (fixedText(type) ?? name).toLowerCase();
  return commandNames.find(
    (command) => command === word || command.split(' ')[0] === word.split(' ')[0]
  );
};

/** Rules the cursor locator reports as slots, which a provider must fill. */
const SLOT_RULES: readonly string[] = PREFERRED_RULES;

/** Rules whose subtree another part fills: the expression engine, or a nested command. */
const FILLED_ELSEWHERE: readonly string[] = [...EXPRESSION_RULES, 'subquery', 'forkSubQuery'];

const defaultSlotRules = DEFAULT_SLOTS.map(({ rule }) => rule);

/**
 * The slots of a command's grammar no provider fills: a call of a slot rule reached without a
 * role on the way (a role says what fills the argument, as a column or a constant), outside an
 * expression and not filled by a default slot. Paths read `limitCommand > constant`.
 */
const unfilledSlots = (command: string): string[] => {
  const found: string[] = [];
  const walk = (rule: string, path: string[]) => {
    for (const called of getCalledRules(rule)) {
      const callPath = [...path, called];
      const hasRole = getCallSites(rule, called).some((site) => getArgumentRole(site));
      const isNested = called.endsWith('Command') && called !== command;
      if (hasRole || isNested || FILLED_ELSEWHERE.includes(called) || path.includes(called)) {
        continue;
      }
      if (SLOT_RULES.includes(called)) {
        if (!defaultSlotRules.includes(called)) {
          found.push(callPath.join(' > '));
        }
        continue;
      }
      walk(called, callPath);
    }
  };
  walk(command, [command]);
  return [...new Set(found)];
};

/** The command rules the generic autocomplete fills: of registered commands without their own. */
const genericCommandRules = [
  ...new Set(
    [...commandStarts].flatMap(([token, rule]) => {
      const command = registeredCommandFor(token);
      const methods = command && esqlCommandRegistry.getCommandMethods(command);
      return methods && !methods.autocomplete ? [rule] : [];
    })
  ),
];

describe('grammar conformance', () => {
  describe('keywords', () => {
    it('are each offered by an item, or listed with why not', () => {
      const mapped = getMappedKeywordTokens();
      const unhandled = keywordTokens.filter(
        (token) =>
          !mapped.has(token) &&
          !EXPRESSION_ENGINE_TOKENS.has(token) &&
          !(token in UNOFFERED_KEYWORDS)
      );

      expect(
        unhandled.map(
          (token) =>
            `${token}: add an item in commands/registry/keyword_items.ts, or list it in UNOFFERED_KEYWORDS with why`
        )
      ).toEqual([]);
    });

    it('are listed as not offered only while that holds', () => {
      const mapped = getMappedKeywordTokens();
      const stale = Object.keys(UNOFFERED_KEYWORDS).filter(
        (token) => !keywordTokens.includes(token) || mapped.has(token)
      );

      expect(stale.map((token) => `${token}: remove it from UNOFFERED_KEYWORDS`)).toEqual([]);
    });
  });

  describe('commands', () => {
    it('are each registered, or listed as unsupported with why', () => {
      const unregistered = [...commandTokens].filter(
        (token) =>
          !isDevOnly(token) && !registeredCommandFor(token) && !(token in UNSUPPORTED_COMMANDS)
      );

      expect(
        unregistered.map(
          (token) =>
            `${token}: register the command in commands/registry/index.ts, or list it in UNSUPPORTED_COMMANDS with why`
        )
      ).toEqual([]);
    });

    it('are listed as aliases or unsupported only while that holds', () => {
      const staleAliases = Object.keys(COMMAND_ALIASES).filter(
        (token) => !commandTokens.has(token) || !commandNames.includes(COMMAND_ALIASES[token])
      );
      const staleUnsupported = Object.keys(UNSUPPORTED_COMMANDS).filter(
        (token) => !commandTokens.has(token) || registeredCommandFor(token)
      );

      expect([
        ...staleAliases.map((token) => `${token}: fix or remove it in COMMAND_ALIASES`),
        ...staleUnsupported.map((token) => `${token}: remove it from UNSUPPORTED_COMMANDS`),
      ]).toEqual([]);
    });
  });

  describe('slots', () => {
    it('are checked for every command on the generic autocomplete', () => {
      // A guard against the check silently covering nothing.
      expect(genericCommandRules).toEqual(
        expect.arrayContaining(['limitCommand', 'statsCommand', 'fromCommand', 'letCommand'])
      );
      expect(genericCommandRules).not.toContain('promqlCommand');
    });

    it('are each filled by a role or a default slot, or listed with why not', () => {
      const unfilled = genericCommandRules
        .flatMap(unfilledSlots)
        .filter((path) => !(path in UNFILLED_SLOTS));

      expect(
        unfilled.map(
          (path) =>
            `${path}: give the call a role in esql_js_prototype/argument_roles/argument_roles.ts, or list it in UNFILLED_SLOTS with why`
        )
      ).toEqual([]);
    });

    it('are listed as unfilled only while that holds', () => {
      const unfilled = new Set(genericCommandRules.flatMap(unfilledSlots));
      const stale = Object.keys(UNFILLED_SLOTS).filter((path) => !unfilled.has(path));

      expect(stale.map((path) => `${path}: remove it from UNFILLED_SLOTS`)).toEqual([]);
    });
  });
});
