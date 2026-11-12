/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

// Benchmarks the public suggest() of this package, or of another checkout of it, over a fixed
// set of cursor positions. Run from the Kibana root:
//
//   node src/platform/packages/shared/esql/kbn-esql-language/scripts/benchmark_autocomplete.js \
//     positions <positions.json>
//   ... run <positions.json> <result.json> [--root <checkout root holding src/platform/...>]
//   ... compare <base result.json> <new result.json>
require('@kbn/setup-node-env');
require('./benchmark_autocomplete/cli').main(process.argv.slice(2));
