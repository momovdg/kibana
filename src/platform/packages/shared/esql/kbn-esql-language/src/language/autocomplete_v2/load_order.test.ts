/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

/*
 * The package has import cycles through its entry (a command's file imports the entry, the
 * entry exports this flow). So a module of the engine can be loaded while the modules it
 * imports are still loading, and reading one of their values at that moment fails in the
 * browser ("Cannot access ... before initialization"). The rule: a module of the engine reads
 * nothing of a module outside the engine while it loads; it may read it inside a function.
 */

// Modules that load fully before the engine does: they import nothing of this package.
const LOADS_FIRST = /esql_js_sim\/|^@|^[a-z]/;

const engineFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return engineFiles(path);
    }

    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

const isInEngine = (source: string): boolean =>
  source.startsWith('./') || /^\.\.\/(?!\.\.)/.test(source);

/** The names a file imports as values from modules that may still be loading. */
const getOutsideImports = (file: ts.SourceFile, isNested: boolean): Set<string> => {
  const names = new Set<string>();

  file.statements.filter(ts.isImportDeclaration).forEach(({ importClause, moduleSpecifier }) => {
    const source = ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : '';
    const isInside = isNested ? isInEngine(source) : source.startsWith('./');
    const bindings = importClause?.namedBindings;

    if (!importClause || importClause.isTypeOnly || isInside || LOADS_FIRST.test(source)) {
      return;
    }
    if (importClause.name) {
      names.add(importClause.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      bindings.elements
        .filter(({ isTypeOnly }) => !isTypeOnly)
        .forEach(({ name }) => names.add(name.text));
    }
  });

  return names;
};

/** The imported names a file reads while it loads: outside any function and any type. */
const getLoadTimeReads = (file: ts.SourceFile, imported: Set<string>): string[] => {
  const reads: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isTypeNode(node) || ts.isImportDeclaration(node)) {
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      return;
    }
    if (ts.isIdentifier(node) && imported.has(node.text)) {
      reads.push(node.text);
    }
    ts.forEachChild(node, visit);
  };

  file.statements.forEach(visit);

  return reads;
};

describe('autocomplete v2 load order', () => {
  it('reads nothing of a module outside the engine while a module loads', () => {
    const violations = engineFiles(__dirname).flatMap((path) => {
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
      const isNested = relative(__dirname, path).includes('/');

      return getLoadTimeReads(file, getOutsideImports(file, isNested)).map(
        (name) => `${relative(__dirname, path)}: ${name}`
      );
    });

    expect(violations).toEqual([]);
  });
});
