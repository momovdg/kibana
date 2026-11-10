# esql-js prototype

This folder prototypes, inside Kibana, two additions that would later move to
[esql-js](https://github.com/elastic/esql-js). Everything outside this folder imports only
`index.ts`, and the folder imports nothing from Kibana (see `boundary.test.ts`), so moving it
upstream means replacing that import.

| Here | Upstream | What |
| --- | --- | --- |
| `grammar_labels/` | `@elastic/esql-grammar` | Generated: every labelled rule call of the grammar (`oldName=qualifiedNamePattern`), with the tokens that can come right before and after it. Mechanical, produced when the grammar is generated. `getCallSites` gives the same for any rule call, labelled or not, read from the parser's ATN at runtime. |
| `argument_roles/` | `@elastic/esql-definitions` | Hand-maintained: what each command argument is in the language (an existing column, a new column, an enrich policy, an integer, …), in the shape of a function parameter's `ParamHint`. Keyed by label, or by `rule>calledRule` where the grammar has no label. Arguments that are bare tokens, with no rule, are keyed by `rule>TOKEN`, as the METADATA fields (`metadata>UNQUOTED_SOURCE`). |

Roles describe the language only. The test for a role: validation could check it. How an
editor presents it (which values to propose, snippets, spacing) stays in Kibana.

Regenerate the labels after an `@elastic/esql` upgrade (from the Kibana root):

```sh
node src/platform/packages/shared/esql/kbn-esql-language/scripts/generate_grammar_labels.js
```

`grammar_labels.test.ts` fails when the checked-in table no longer matches the installed grammar,
and `argument_roles.test.ts` fails when a labelled argument has no role and is not listed as
unclassified.
