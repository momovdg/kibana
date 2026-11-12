/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Parser } from '@elastic/esql';
import { esqlCommandRegistry } from '../../src/commands/registry';
import { locateCursor } from '../../src/language/shared/cursor_location/cursor_location';
import type { CursorLocation } from '../../src/language/shared/cursor_location/types';

/** What the cursor is at: what the timings are grouped by. */
export type PositionType = 'new command' | 'keyword' | 'column slot' | 'expression' | 'nested';

export interface Position {
  query: string;
  offset: number;
  type: PositionType;
  /** Where the position comes from: the plan's tables, the long query, or an example. */
  source: string;
}

const SOURCE = 'FROM kibana_sample_data_logs';

/** The cursor-location table of PR 1b: the cursor is at the end. */
const LOCATOR_TABLE = [
  ' FROM a | ENRICH  ',
  ' FROM a | ENRICH pol  ',
  ' FROM a | RENAME x  ',
  ' FROM a | KEEP x,  ',
  ' FROM a | LIMIT  ',
  ' FROM a | LIMIT 10  ',
  ' FROM a | WHERE msg == "a | b" AND  ',
  'FROM a // x | y\n | LIMIT  ',
  ' FROM a | FORK (WHERE x | SORT y) (WHERE  ',
  ' FROM a, (FROM b | KEEP  ',
  'FROM a | LIM',
];

/** The appendix's manual checklist; `…` stands for the sample web logs' source. */
const CHECKLIST = [
  `${SOURCE} | LIM`,
  `${SOURCE} | LIMIT  `,
  `${SOURCE} | KEEP host,  `,
  `${SOURCE} | RENAME \`my field\`  `,
  `${SOURCE} | RENAME bytes  `,
  `${SOURCE} | SORT bytes  `,
  `${SOURCE} | SORT bytes DESC /* c */  `,
  `${SOURCE} | SORT (bytes)`,
  `${SOURCE} | ENRICH  `,
  `${SOURCE} | ENRICH policy  `,
  `${SOURCE} | ENRICH _any:`,
  `${SOURCE} | ENRICH _any:policy ON  `,
  `${SOURCE} | ENRICH policy WITH  `,
  `${SOURCE} | WHERE message == "a | b" AND  `,
  `${SOURCE} // note | x\n | LIMIT  `,
  `${SOURCE} | STATS c = COUNT(*) BY  `,
  `${SOURCE} | FORK (WHERE a > 1 | SORT b) (WHERE  `,
  ` FROM a, (FROM b | KEEP  `,
  `${SOURCE} | where  `,
];

/** A long query, with the cursor at the end of each command and inside a middle EVAL. */
const LONG_QUERY = [
  SOURCE,
  'WHERE bytes > 1000 AND message LIKE "*error*"',
  'EVAL kb = bytes / 1024, day = DATE_TRUNC(1 day, @timestamp)',
  'EVAL x = ROUND(kb, 2)',
  'DISSECT message "%{verb} %{path}"',
  'STATS total = SUM(kb), hits = COUNT(*) BY day, host',
  'EVAL avg_kb = total / hits',
  'SORT total DESC NULLS LAST',
  'KEEP day, host, total, hits, avg_kb',
  'RENAME total AS total_kb',
  'LIMIT 100',
].join('\n| ');

/** `… | X` reads from a source, and a header statement is followed by a query. */
const toQuery = (example: string, type: string | undefined): string => {
  const query = example.replace(/^…\s*\|/, 'FROM a |');
  return type === 'header' ? `${query}\nFROM a` : query;
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

const NESTING_RULES = ['subquery', 'forkSubQuery'];
const EXPRESSION_RULES = ['booleanExpression', 'primaryExpression'];
const COLUMN_RULES = ['qualifiedName', 'qualifiedNamePattern'];

/** The kind of position, from the cursor location the branch's locator reports. */
const typeOf = ({ expectedRules, expectedTokens, tokenStacks }: CursorLocation): PositionType => {
  const stacks = [
    ...expectedRules.map(({ stack, rule }) => [...stack, rule]),
    ...[...expectedTokens].map((type) => tokenStacks.get(type)?.rules ?? []),
  ];
  if (stacks.some((rules) => rules.some((rule) => NESTING_RULES.includes(rule)))) {
    return 'nested';
  }
  if ([...expectedTokens].some((type) => tokenStacks.get(type)?.startsCommand)) {
    return 'new command';
  }
  if (expectedRules.some(({ stack }) => stack.some((rule) => EXPRESSION_RULES.includes(rule)))) {
    return 'expression';
  }
  if (expectedRules.some(({ rule }) => COLUMN_RULES.includes(rule))) {
    return 'column slot';
  }
  return 'keyword';
};

const at = (query: string, offset: number, source: string): Position => ({
  query,
  offset,
  source,
  type: typeOf(locateCursor(query, offset)),
});

/** The plan's query set (Section 6), each position with its type. */
export const buildPositions = (): Position[] => {
  const longQueryEnds = LONG_QUERY.split('\n| ').map(
    (_, index, commands) => commands.slice(0, index + 1).join('\n| ').length
  );
  const middleEval = LONG_QUERY.indexOf('EVAL x = ') + 'EVAL x = '.length;
  const examples = esqlCommandRegistry
    .getAllCommands()
    .flatMap(({ metadata }) =>
      (metadata.examples ?? [])
        .map((example) => toQuery(example, metadata.type))
        .filter((query) => !Parser.parse(query).errors.length)
    );
  return [
    ...LOCATOR_TABLE.map((query) => at(query, query.length, 'locator table')),
    ...CHECKLIST.map((query) => at(query, query.length, 'checklist')),
    ...[...longQueryEnds, middleEval].map((offset) => at(LONG_QUERY, offset, 'long query')),
    ...examples.flatMap((query) =>
      tokenBoundaries(query).map((offset) => at(query, offset, 'examples'))
    ),
  ];
};
