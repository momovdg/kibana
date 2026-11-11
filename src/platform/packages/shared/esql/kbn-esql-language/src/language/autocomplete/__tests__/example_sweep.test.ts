/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { Parser, Walker } from '@elastic/esql';
import type { ESQLColumn } from '@elastic/esql/types';
import { esqlCommandRegistry } from '../../../commands/registry';
import { keywordsAt } from '../../../commands/registry/keyword_items';
import { locateCursor } from '../../shared/cursor_location/cursor_location';
import { createCustomCallbackMocks, fields, setup } from './helpers';

/**
 * Runs the full suggest() at every token boundary of every command's metadata examples: it must
 * never throw, and wherever the grammar expects a keyword something must be offered.
 */

/** Examples that don't parse, with why. Fixing them changes what users see in the docs. */
const STALE_EXAMPLES: Readonly<Record<string, string>> = {
  'ROW question = "What is Elasticsearch?"\n| COMPLETION answer = question WITH test_completion_model\n| KEEP question, answer':
    'COMPLETION now takes a map after WITH, as `WITH { "inference_id": "…" }`',
  'FROM employees\n| KEEP emp_no\n| SAMPLE 0.05,': 'ends with a stray comma',
};

/**
 * The query an example stands for: `… | LIMIT 1` reads from a source, and a header statement
 * is followed by a query.
 */
const toQuery = (example: string, type: string | undefined): string => {
  const query = example.replace(/^…\s*\|/, 'FROM a |');
  return type === 'header' ? `${query}\nFROM a` : query;
};

const examples = esqlCommandRegistry.getAllCommands().flatMap(({ name, metadata, methods }) =>
  (metadata.examples ?? []).map((example) => ({
    name,
    example,
    query: toQuery(example, metadata.type),
    // A command's own autocomplete (PROMQL) follows its own rules.
    isGeneric: !methods.autocomplete,
  }))
);

/** The examples' columns, so their expressions read known fields, plus their enrich policy. */
const createCallbacks = () => {
  const names = new Set(
    examples.flatMap(({ query }) =>
      Walker.findAll(Parser.parse(query).root, (node) => node.type === 'column').map((node) =>
        (node as ESQLColumn).parts.join('.')
      )
    )
  );
  return createCustomCallbackMocks(
    [
      ...fields,
      ...[...names].map((name) => ({ name, type: 'double' as const, userDefined: false as const })),
    ],
    undefined,
    [
      {
        name: 'my-policy',
        sourceIndices: ['a'],
        matchField: 'pivotField',
        enrichFields: ['enrichFieldA', 'enrichFieldB'],
      },
    ]
  );
};

/** The offsets between tokens: where each visible token starts and ends. */
const tokenBoundaries = (query: string): number[] => {
  const { tokens } = Parser.create(query);
  tokens.fill();
  const offsets = new Set<number>();
  for (const { channel, type, start, stop } of tokens.tokens) {
    if (channel === 0 && type !== -1) {
      offsets.add(start);
      offsets.add(stop + 1);
    }
  }
  return [...offsets].filter((offset) => offset > 0).sort((a, b) => a - b);
};

describe('example sweep', () => {
  const callbacks = createCallbacks();

  it('lists only examples that are still stale', () => {
    const parsing = Object.keys(STALE_EXAMPLES).filter(
      (example) =>
        !examples.some((entry) => entry.example === example) ||
        !Parser.parse(examples.find((entry) => entry.example === example)?.query ?? '').errors
          .length
    );

    expect(parsing.map((example) => `${example}: remove it from STALE_EXAMPLES`)).toEqual([]);
  });

  it.each(examples.map((entry) => [`${entry.name}: ${entry.example}`, entry] as const))(
    '%s',
    async (_, { example, query, isGeneric }) => {
      if (example in STALE_EXAMPLES) {
        return;
      }
      expect(Parser.parse(query).errors.map(({ message }) => message)).toEqual([]);

      const { suggest } = await setup('^');
      const failures: string[] = [];
      for (const offset of tokenBoundaries(query)) {
        const before = query.slice(0, offset);
        const after = query.slice(offset);
        let texts: string[];
        try {
          texts = (await suggest(`${before}^${after}`, { callbacks })).map(({ text }) => text);
        } catch (error) {
          failures.push(`${JSON.stringify(before)}: threw ${error}`);
          continue;
        }
        // A `;` that already follows ends the statement, so none is offered.
        const keywords = keywordsAt(locateCursor(query, offset)).filter(
          ({ token }) => !(token === 'SEMICOLON' && /^\s*;/.test(after))
        );
        if (isGeneric && keywords.length && !texts.length) {
          const tokens = [...new Set(keywords.map(({ token }) => token))];
          failures.push(
            `${JSON.stringify(before)}: expects ${tokens.join(', ')} but suggests nothing`
          );
        }
      }

      expect(failures).toEqual([]);
    }
  );
});
