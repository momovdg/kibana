/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Parser } from '@elastic/esql';
import { Token } from 'antlr4';
import { esqlCommandRegistry } from '../../../commands/registry';
import { locateCursor } from './cursor_location';

const { symbolicNames } = Parser.create('').parser;

/** Locates the cursor at the end of `text`. */
const locate = (text: string) => locateCursor(text, text.length);

const tokenNames = (text: string) =>
  [...locate(text).expectedTokens]
    .map((type) => (type === Token.EOF ? 'EOF' : symbolicNames[type]))
    .sort();

const ruleNames = (text: string) =>
  locate(text)
    .expectedRules.map(({ rule }) => rule)
    .sort();

const EXPRESSION_RULES = ['constant', 'functionName', 'qualifiedName'];

describe('locateCursor', () => {
  describe('expected tokens and rules', () => {
    it.each([
      [' FROM a | ENRICH  ', ['enrichPolicyName']],
      [' FROM a | KEEP x,  ', ['qualifiedNamePattern']],
      [' FROM a | LIMIT  ', ['constant']],
      [' FROM a | WHERE msg == "a | b" AND  ', EXPRESSION_RULES],
      ['FROM a // x | y\n | LIMIT  ', ['constant']],
      [' FROM a | FORK (WHERE x | SORT y) (WHERE  ', EXPRESSION_RULES],
      [' FROM a, (FROM b | KEEP  ', ['qualifiedNamePattern']],
    ])('returns the slots at %j', (text, rules) => {
      expect(ruleNames(text)).toEqual(rules);
    });

    it('returns the ENRICH keywords and the pipe after the policy name', () => {
      expect(tokenNames(' FROM a | ENRICH pol  ')).toEqual(['EOF', 'ON', 'PIPE', 'WITH']);
    });

    it('returns exactly AS and = after a RENAME column', () => {
      expect(tokenNames(' FROM a | RENAME x  ')).toEqual(['AS', 'ASSIGN']);
    });

    it('returns BY and the pipe after a LIMIT value', () => {
      expect(tokenNames(' FROM a | LIMIT 10  ')).toEqual(['BY', 'EOF', 'PIPE']);
    });

    it('returns the tokens after the first command', () => {
      expect(tokenNames(' FROM a  ')).toEqual(['COMMA', 'EOF', 'METADATA', 'PIPE']);
    });

    it('keeps the pipe inside a string out of the anchoring', () => {
      const { ruleStack } = locate(' FROM a | WHERE msg == "a | b" AND  ');

      expect(ruleStack.slice(0, 2)).toEqual(['processingCommand', 'whereCommand']);
    });

    it('treats lowercase keywords like uppercase ones', () => {
      expect(ruleNames(' from a | where  ')).toEqual(ruleNames(' FROM a | WHERE  '));
      expect(tokenNames(' from a | enrich pol  ')).toEqual(tokenNames(' FROM a | ENRICH pol  '));
    });
  });

  describe('ruleStack', () => {
    it('names the command at the cursor', () => {
      expect(locate(' FROM a | ENRICH pol  ').ruleStack).toEqual([
        'processingCommand',
        'enrichCommand',
      ]);
    });

    it('contains forkSubQuery inside a FORK branch', () => {
      expect(locate(' FROM a | FORK (WHERE x | SORT y) (WHERE  ').ruleStack).toEqual(
        expect.arrayContaining(['forkCommand', 'forkSubQuery', 'whereCommand'])
      );
    });

    it('contains subquery inside a FROM subquery', () => {
      expect(locate(' FROM a, (FROM b | KEEP  ').ruleStack).toEqual(
        expect.arrayContaining(['subquery', 'processingCommand', 'keepCommand'])
      );
    });
  });

  describe('commandCanEnd', () => {
    it.each([
      [' FROM a | ENRICH pol  ', true],
      [' FROM a | ENRICH pol ON x  ', true],
      [' FROM a | SORT b  ', true],
      [' FROM a | STATS c = COUNT(*)  ', true],
      ['FROM employees | SAMPLE 0.05 ', true],
      [' FROM a  ', true],
      [' FROM a | RENAME x  ', false],
      [' FROM a | LIMIT  ', false],
      [' FROM a | KEEP x,  ', false],
      [' FROM a | WHERE x > 1 AND  ', false],
    ])('is %j -> %s', (text, expected) => {
      const { commandCanEnd, expectedTokens } = locate(text);
      const pipe = symbolicNames.indexOf('PIPE');

      expect(commandCanEnd).toBe(expected);
      expect(expectedTokens.has(pipe)).toBe(expected);
    });

    it('offers RP instead of EOF when a nested command can end', () => {
      expect(tokenNames(' FROM a, (FROM b | KEEP x  ')).toEqual(
        expect.arrayContaining(['PIPE', 'RP'])
      );
    });
  });

  describe('segment', () => {
    it.each([
      [' FROM a | ENRICH pol  ', 'ENRICH pol  '],
      [' FROM a  ', 'FROM a  '],
      [' FROM a, (FROM b | KEEP  ', 'KEEP  '],
      [' FROM a | FORK (WHERE x | SORT y) (WHERE  ', 'WHERE  '],
      ['FROM a | LIM', 'LIM'],
      ['FROM a | ', ''],
      ['SET a = 1; FROM b | LIMIT ', 'LIMIT '],
    ])('at %j is %j', (text, segmentText) => {
      const { segment } = locate(text);

      expect(segment).toEqual({
        start: text.length - segmentText.length,
        end: text.length,
        text: segmentText,
      });
    });

    it('is the command at the cursor in multi-line input, not the last one', () => {
      const text = 'FROM a\n| EVAL x = \n| WHERE b > 1';
      const offset = text.indexOf('= ') + 2;
      const { segment, ruleStack } = locateCursor(text, offset);

      expect(segment.text).toBe('EVAL x = ');
      expect(ruleStack.slice(0, 2)).toEqual(['processingCommand', 'evalCommand']);
    });
  });

  describe('partial', () => {
    it('is the word being typed', () => {
      const { partial } = locate('FROM a | LIM');

      expect(partial).toEqual({ text: 'LIM', start: 9 });
      expect(tokenNames('FROM a | LIM')).toEqual(expect.arrayContaining(['LIMIT']));
    });

    it('is undefined after whitespace', () => {
      expect(locate('FROM a | LIMIT ').partial).toBeUndefined();
    });

    it.each([
      ['FROM a | KEEP `my fi', '`my fi', ['qualifiedNamePattern']],
      ['FROM a | EVAL x = "ab', '"ab', EXPRESSION_RULES],
    ])('covers the unterminated quote in %j', (text, partialText, rules) => {
      expect(locate(text).partial).toEqual({
        text: partialText,
        start: text.length - partialText.length,
      });
      expect(ruleNames(text)).toEqual(rules);
    });
  });

  describe('inComment', () => {
    it.each([
      ['FROM a // note', true],
      ['FROM a /* note', true],
      ['FROM a | WHERE x /* note', true],
      ['FROM a // note\n', false],
      ['FROM a /* note */ ', false],
    ])('is %j -> %s', (text, expected) => {
      expect(locate(text).inComment).toBe(expected);
    });

    it('collects no candidates inside a comment', () => {
      const { expectedTokens, expectedRules } = locate('FROM a // note');

      expect(expectedTokens.size).toBe(0);
      expect(expectedRules).toEqual([]);
    });
  });

  describe('continuation', () => {
    it.each([
      ['FROM a | WHERE @timestamp > NOW() - 1 ', 'constant', true],
      [' FROM a  ', 'indexPattern', true],
      [' FROM a | KEEP x,  ', 'qualifiedNamePattern', false],
      ['FROM a | WHERE ms', 'qualifiedName', false],
    ])('at %j marks %s as %s', (text, rule, expected) => {
      const expectedRule = locate(text).expectedRules.find((candidate) => candidate.rule === rule);

      expect(expectedRule?.continuation).toBe(expected);
    });
  });

  it('never throws at any token boundary of the command examples', () => {
    const examples = esqlCommandRegistry
      .getAllCommands()
      .flatMap(({ metadata }) => metadata.examples)
      .map((example) => example.replace(/^…/, 'FROM a '));

    expect(examples.length).toBeGreaterThan(50);

    for (const example of examples) {
      const { tokens } = Parser.create(example);
      tokens.fill();
      const offsets = new Set([0, example.length]);
      for (const { start, stop } of tokens.tokens) {
        offsets.add(Math.max(start, 0));
        offsets.add(Math.max(stop + 1, 0));
      }

      for (const offset of offsets) {
        expect(() => locateCursor(example, offset)).not.toThrow();
      }
    }
  });
});
