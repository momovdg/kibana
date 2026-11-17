/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ENGINE_ENTRY = 'suggestForExpression';
const ENGINE_MODULE = 'suggestion_engine';

/**
 * What to offer inside an expression is decided in this flow, from the grammar position. The
 * expression engine of the current flow, which works the position out from the syntax tree
 * and the text, is not used: neither its entry nor its module is named by a provider.
 */
describe('the expression rules', () => {
  const folders = [__dirname, join(__dirname, '../providers')];
  const sources = folders.flatMap((folder) =>
    readdirSync(folder)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => join(folder, name))
  );

  it('has files to check', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(sources)('%s does not use the expression engine of the current flow', (path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain(ENGINE_ENTRY);
    expect(source).not.toContain(ENGINE_MODULE);
  });
});
