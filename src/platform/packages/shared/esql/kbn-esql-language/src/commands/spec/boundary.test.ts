/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { esqlCommandRegistry } from '../registry';

const REGISTRY_DIR = resolve(__dirname, '../registry');
// `from` is followed by a space in an import: a text that happens to hold the word is not one.
const IMPORT = /\bfrom\s+['"]([^'"]+)['"]/g;
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1).)*)\1/g;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });

/**
 * The code that reads specs serves every command and knows none: what is particular to a
 * command is in that command's spec.
 */
describe('the spec engine', () => {
  const files = sourceFiles(__dirname).map((path) => ({
    name: relative(__dirname, path),
    path,
    source: readFileSync(path, 'utf8'),
  }));
  const commandNames = esqlCommandRegistry.getAllCommandNames();

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(3);
    expect(commandNames.length).toBeGreaterThan(20);
  });

  it('imports nothing from the folder of a command', () => {
    const violations = files.flatMap(({ name, path, source }) =>
      [...source.matchAll(IMPORT)]
        .map(([, target]) => target)
        .filter((target) => target.startsWith('.'))
        .map((target) => relative(REGISTRY_DIR, resolve(dirname(path), target)))
        // Inside the registry, and in a folder of it: that is a command's own code.
        .filter((target) => !target.startsWith('..') && target.includes(sep))
        .map((target) => `${name}: ${target}`)
    );

    expect(violations).toEqual([]);
  });

  it('names no command', () => {
    const violations = files.flatMap(({ name, source }) =>
      [...source.matchAll(STRING_LITERAL)]
        .map(([, , text]) => text)
        .filter((text) => commandNames.includes(text.toLowerCase()))
        .map((text) => `${name}: '${text}'`)
    );

    expect(violations).toEqual([]);
  });
});
