/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|js)$/.test(name) ? [path] : [];
  });

const IMPORT = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
// What esql-js packages can depend on, plus Node built-ins for the generator.
const ALLOWED = [/^@elastic\/esql/, /^antlr4$/, /^fs$/, /^path$/];

/** A relative import that stays inside this folder, or an allowed package. */
const isAllowed = (file: string, source: string): boolean =>
  /^\.\.?(\/|$)/.test(source)
    ? resolve(dirname(file), source).startsWith(__dirname)
    : ALLOWED.some((pattern) => pattern.test(source));

describe('esql-js prototype boundary', () => {
  it('imports nothing from Kibana', () => {
    const violations = files(__dirname).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(IMPORT)]
        .map(([, source]) => source)
        .filter((source) => !isAllowed(file, source))
        .map((source) => `${file.replace(__dirname, '.')}: ${source}`)
    );

    expect(violations).toEqual([]);
  });

  it('stays out of Kibana code except through index.ts', () => {
    const root = join(__dirname, '..');
    const violations = files(root)
      .filter((file) => !file.startsWith(__dirname))
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(IMPORT)]
          .map(([, source]) => source)
          .filter((source) => /esql_js_prototype\/./.test(source))
          .map((source) => `${file.replace(root, '.')}: ${source}`)
      );

    expect(violations).toEqual([]);
  });
});
