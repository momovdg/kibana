# Autocomplete v2

The grammar-driven autocomplete engine, built next to the current flow in `../autocomplete`. Both
export a `suggest` with the same signature. The package exports one of them from
`../index.ts`, so switching flows is one line.

The engine knows no command. A command gets its suggestions from the grammar position of the
cursor and from the command signatures in `../../esql_js_sim`. Rules, enforced by
`boundary.test.ts`:

- No import from a command's folder under `commands/registry/`.
- No command name and no grammar rule name of a command (`whereCommand`) as a string.
- A provider override is the only exception. It is keyed by an argument, never by a command,
  it is listed in `overrides.ts`, and the list may grow only with an owner and an issue.

## The four steps

`suggest(fullText, offset, callbacks)` has the signature of the current flow's `suggest`.

1. **Locate** (`esql_js_sim/grammar`): where the cursor is in the grammar.
2. **Resolve** (`resolve.ts`): what has to be offered there, as a list of requests. A request
   is a kind of thing: the names of commands, a token, the end of the command, an argument
   with its role, an expression with its role. It is pure: nothing is fetched.
3. **Provide** (`providers/`): the items for each request. A provider is chosen by the kind of
   the request and knows the editor only through the context (`context.ts`).
4. **Present** (in `suggest.ts` for now): the final list.

What the engine offers today:

- Command names, with the license, tier, time-series and "hidden after" gates of the
  registered commands.
- Keywords, the pipe, the separator of a list and the next line. A keyword is presented by
  what the grammar allows right after it (`getTokenSuccessors`): alone when nothing has to
  follow (`ASC`), joined with the keywords that have to follow (`NULLS FIRST`), with the
  braces of a map (`WITH { $0 }`), or with a space when anything else has to follow (`BY `).
- Arguments with the roles `column` (by type, each listed once where the role says so),
  `new_name` (a free name with its assignment), `constant` (its allowed values), `entity`,
  `map` (the keys not used yet, and the values of the key before the cursor), `option_name`
  (the options not used and not in conflict with a used one) and `dependent_value` (the role
  the name gives it, listed in the signature or defined by the named entity).
- Expressions, by the mode and the types of their role. Sublanguages are resolved and not
  provided yet.

Inside an open string only a value is offered: the value of a map key or a constant.

An expression is one request, whatever the cursor is nested in: its operands, its operators,
its brackets and the arguments of its functions are offered together
(`providers/expressions.ts`). The items come from the expression engine the commands of the
current flow share. The provider tells that engine what the role and the grammar know:

- which functions and operators apply, from the mode of the role (and the roles around it: a
  filter inside an aggregation);
- the types the role accepts, whether subqueries may appear, where full-text functions may;
- what is written of the expression: the grammar gives where it starts, and the node of the
  syntax tree that starts there is handed over.

While something is written that is not yet a whole expression of the type its role asks for,
the command cannot go on: no pipe, no keyword and no separator of the command is offered.

A lambda (`v -> v > 1`) is part of an expression (`providers/lambdas.ts`). The grammar allows
one as any argument of any function; which argument takes one is a fact of the function
(`FUNCTION_LAMBDAS` in the definitions, empty until a function Kibana knows declares one):

- where that argument starts, only the parameters with the arrow are offered (`x -> `), with
  names the query does not use; after a parameter's name, only the arrow;
- in the body, the parameters of every lambda around the cursor are offered next to the
  columns, and nowhere else. A parameter has the type of the argument whose values it stands
  for, when the function says which (`valuesOf`);
- the body is offered as the value of the argument: the expression engine does not know
  lambdas, so it reads the text with the parameters and the arrow blanked out.

What to offer inside an expression is decided in this flow. The expression engine of the
current flow (`suggestForExpression`), which works the position out from the syntax tree and
the text, is not used.

- `providers/expression_position.ts` says where the cursor is inside the expression from the
  grammar position alone: the start of an operand, after an operand, after an operator, after
  `NOT` or a cast, in a string or a map, and the function call and argument the cursor is in.
  `expression_position.test.ts` keeps, in a snapshot, how this agrees with what the current
  engine works out, on every scenario row.
- `providers/expression_decisions.ts` decides the items for each position, and
  `providers/expression_special_operators.ts` those of `NOT`, `IS`, `LIKE` and `IN`. The
  operands of an operator come from the written tree, so precedence is the grammar's.
- `expression_current_flow.test.ts` compares, item by item with the current flow, the
  positions no scenario table has a row for.

What is shared with the current flow, by design:

- the item builders (columns, functions, operators and literals by type) and the small rule
  helpers over function definitions (which signatures still fit, when a comma follows);
- the function definitions, with the names they use for the places a function is allowed in
  (`MODE_LOCATIONS` maps the mode of a role to them);
- the type of a written expression, read from the syntax tree of the command: the grammar
  gives the range, the tree gives the type.

Where the new flow differs from the current engine on purpose:

- after a keyword of the command typed in full (`SORT a ASC`), nothing of the expression is
  offered: it has ended;
- inside a string that is still open, nothing is offered, except the editor's own suggestions
  for a KQL query;
- right after `NOT` at the start of a function argument, the boolean columns and functions
  are offered, as they are outside a call (the current flow offers nothing there).

Entities come from `entities/registry.ts`: one definition per kind, each turning what the
editor provides today into entities, in a scope. The scope is all a definition gets: the index
mode, the parent's name, the task, serverless. `providers/entities.ts` builds the scope from
the role and from what is written (the policy an enrich field depends on), and presents the
entities. The editor's callbacks are unchanged.

The columns a command can read are those of the query before the cursor (`pipeline.ts`): the
commands before it in its pipeline, plus the outer pipeline for a branch, and only the
subquery's own commands for a subquery. They are fetched on the first request, so a position
that offers no column asks the editor for none.

An item for an argument ends with a space, and reopens the suggestions, unless the argument is
an item of a list. There a separator can follow, and it is offered on the name itself.

`__tests__/scenarios/parity.test.ts` runs every scenario table through this flow and keeps,
in a snapshot, how many rows of each command already match the current flow.

What is here so far:

- `command_metadata.ts`: `getRegisteredCommand(commandRule)`, the one function through which
  the engine reads what Kibana registered for a command. It is undefined for a command that
  is in the grammar and that Kibana has not adopted.
- `command_metadata.test.ts`: the snapshot of every position of the registered commands, and
  the list of commands Kibana has not registered. A grammar upgrade shows up as a change here.
- `locate_examples.test.ts`: runs `locate` at every token boundary of the registered command
  examples.
- `signature_coverage.test.ts`: the gate for a new command. A command Kibana registers must
  be described, and every position it has must get its role from a signature.
- `entities/types.ts`: `EntityDefinition`, how the entities of one kind are listed from the
  editor's callbacks, and `EntityRegistry`, one definition per kind. The registry itself comes
  with the engine.
- `suggest.test.ts`: the engine's own tests, by kind of request and not by command.
- `written.ts`: the small questions the engine asks about what is written (the same place,
  the part of an expression, a name without its quotes). They read the Cursor IR. The
  predicates of `@elastic/esql` with similar names (`isColumn`, `isAssignment`) are about
  nodes of the syntax tree, which the engine does not read for the command at the cursor.

## Flow map

One call to `suggest`, followed through the four steps on real queries. `▮` is the cursor.
The values are what the code returns for the test world of the scenario kit; long lists are
cut. The words are explained, in the same order, in the vocabulary below.

```
 text, offset
      │
      ▼
 ┌─────────┐  Cursor IR   ┌─────────┐  requests   ┌─────────┐  items   ┌─────────┐
 │ locate  │ ───────────▶ │ resolve │ ──────────▶ │ provide │ ───────▶ │ present │ ──▶ list
 └─────────┘              └─────────┘             └─────────┘          └─────────┘
   grammar                 signatures              one provider          follow-ups,
   (esql_js_sim/grammar)   (esql_js_sim/           per kind, with        no duplicates
                           definitions)            the context:
                                                   columns, entities,
                                                   editor callbacks
```

Only `provide` talks to the editor, and only for what the request needs.

### 1. An argument with a role: `FROM a | KEEP keywordField, ▮`

The whole flow on the simplest case.

**Locate.** The grammar says where the cursor is and what is already there.

| Field of the IR | Value |
| --- | --- |
| `command` | `keepCommand` |
| `position` | `start_of_argument` |
| `previous` | `,` of class `separator` |
| `word` | none: nothing is typed yet |
| `arguments` (expected) | one, the call site `qualifiedNamePatterns>qualifiedNamePattern`, on the path `keepCommand>qualifiedNamePatterns` / `qualifiedNamePatterns>qualifiedNamePattern` |
| `followers` | none: a name has to come first |
| `written` | `KEEP` (keyword), `keywordField` (at the same call site as the expected argument), `,` (separator) |

**Resolve.** The path is looked up in the signatures. `keepCommand>qualifiedNamePatterns`
has a role, and the argument takes it:

```
{ kind: 'argument',
  argument: qualifiedNamePatterns>qualifiedNamePattern,
  resolved: { role: { kind: 'column', wildcard: 'pattern', unique: true },
              id: 'keepCommand>qualifiedNamePatterns', source: 'signature' } }
```

One request. Nothing was fetched so far.

**Provide.** The request is an argument with a `column` role, so the column provider runs
(`providers/arguments.ts`):

- it asks the context for the columns. The context fetches them now, for the query before
  the cursor's command (`FROM a`);
- `unique` says a column is listed once: the written arguments with the same role
  (`keywordField`) are left out;
- the argument is an item of a list, so the items get no trailing space.

**Present.** 20 items: every column of `a` but `keywordField`.

### 2. An expression: `FROM a | WHERE doubleField > ▮`

Inside an expression the grammar is deep and the engine answers once for the whole of it.

**Locate.** `position` is `start_of_argument`, `previous` is `>` of class `operator`. Six
arguments are expected: a constant, a column and a function name, each along two branches of
the grammar, all under `whereCommand>booleanExpression`. The followers are `(`, `+` and `-`.
`written` has `doubleField` under `valueExpression.left` and `>` as an operator.

**Resolve.** Every expected argument and follower is inside the same expression, so they
become one request, keyed by the expression entry:

```
{ kind: 'expression',
  entry: 'whereCommand>booleanExpression',
  role: { kind: 'expression', mode: 'filter', types: ['boolean'],
          completeAs: 'boolean', subqueries: true } }
```

**Provide.** The expression provider (`providers/expressions.ts`):

- reads the expression position from the written arguments
  (`providers/expression_position.ts`): `after_operator`, with `>` as the last operator and
  `doubleField` as its left operand;
- asks for the type of that operand (`double`), from the columns and the syntax tree of the
  command;
- decides (`providers/expression_decisions.ts`): the right operand of `>` after a `double`
  is a number, so the numeric columns and the functions that return a number, as allowed in
  a `filter`.

It also reports that the expression is unfinished (`doubleField >` is not a boolean yet), so
nothing of the command outside the expression would be offered.

**Present.** 96 items: `doubleField`, `integerField`, `longField`, ..., `ABS($0)`, ...

One space after a value, at `FROM a | WHERE doubleField > 1 ▮`, the same request comes with
two more: the pipe and the end of the command, because the grammar now lets the command
end. The expression is a whole boolean, so they are kept: `AND $0`, `OR $0`, `| ` and the
next line.

### 3. Tokens and their presentation: `FROM a | SORT keywordField ▮`

**Locate.** `position` is `after_argument`. The followers are the operators of an
expression, then `nulls`, `asc`, `desc` (class `keyword`), `,` (`separator`), `|` (`pipe`)
and the end of the text (`end`).

**Resolve.** Seven requests:

| Request | From |
| --- | --- |
| `expression`, entry `orderExpression>booleanExpression`, role `{ mode: 'scalar' }` | the operators: they are tokens of the expression, not of the command |
| `token` × 3 | `nulls`, `asc`, `desc` |
| `token` | `,` |
| `token` | the pipe |
| `end_of_command` | the pipe or the end can follow |

**Provide.**

- Expression: the position is `after_operand` and the operand is a keyword column, so the
  operators that take a keyword (`IN $0`, `LIKE $0`, `IS NULL`, ...).
- Keywords (`providers/tokens.ts`): each is presented by what the grammar allows right after
  it. Nothing has to follow `asc` and `desc`, so they are offered alone. `nulls` has to be
  followed by `first` or `last`, so it is offered joined: `NULLS FIRST`, `NULLS LAST`.
- Separator: `, `. Pipe: `| `. End of the command: the next line.

**Present.** 15 items.

### 4. The other kinds, in short

- **Command names.** `FROM a | ▮` → `position` is `start_of_command` and the followers are
  the keywords that start a command → one `command_names` request with their command rules →
  the provider keeps the rules Kibana registered and that the license, the tier and the
  query allow → `EVAL `, `WHERE `, `KEEP `, ... (28 of the grammar's 33).
- **Entity.** `FROM a | ENRICH ▮` → the expected argument is `enrichCommand.policyName` →
  its role is `{ kind: 'entity', entityType: 'enrich_policy' }` → the entity provider asks
  the `enrich_policy` definition of the registry, which asks the editor for the policies →
  `policy `, `` `policy$` ``. No column is fetched.
- **Constant.** `FROM a | LIMIT ▮` → role `{ kind: 'constant', valueType: 'integer' }` →
  the suggested values of that place, from `presentation.ts` → `10 `, `100 `, `1000 `.
- **New name.** `FROM a | RENAME keywordField AS ▮` → role `{ kind: 'new_name', of: 'column' }`
  → nothing: a name is free text, and it is offered only where the grammar assigns it.
- **Two readings of one place.** `FROM a | STATS avg(doubleField) BY ▮` → two requests: an
  argument with role `new_name` (the name of a grouping) and an expression with mode
  `grouping` → the items of both, in one list (216 here: columns and functions).
- **Follow-up.** `FROM a | KEEP keywordField▮` → the `word` is `keywordField`, a whole name
  that is an existing column → `suggest` looks at what is offered one space later and offers
  the word with each continuation → `keywordField, `, `keywordField | ` and the next line.

## Vocabulary

The words this flow uses, in the order a call to `suggest` meets them. The types behind the
grammar words are in `esql_js_sim/grammar`, those behind the meaning words in
`esql_js_sim/definitions`.

**The two flows**

| Word | Meaning |
| --- | --- |
| Current flow | The autocomplete in `../autocomplete` and in each command's `autocomplete.ts`. Production today. |
| New flow, v2, the engine | This folder. It knows no command. |
| Simulated packages | `esql_js_sim/grammar` and `esql_js_sim/definitions`: what the engine expects from esql-js, kept in Kibana until it can move there. |

**Where the cursor is (locate)**

| Word | Meaning |
| --- | --- |
| Cursor IR | The result of `locate(text, offset)`: a description of the cursor that has the same shape for every command. IR stands for intermediate representation. Everything below in this table is a field of it or a word about it. |
| Position | One of a closed set of places in a command: the start of the query, of a statement, of a command or of an argument, inside an argument, after an argument, inside a string, inside a comment, invalid. |
| Command rule | The grammar rule of a command. The engine never names one; it gets it from the IR and asks `getRegisteredCommand` what Kibana registered for it. |
| Call site | One place in the grammar where a rule takes a rule or a token: `rule.label` when the grammar labels it, `rule>called` otherwise. It is the identity of an argument. |
| Path | The call sites from the command down to an argument. Roles are looked up along it. |
| Expected argument | An argument the grammar allows at the cursor, with its path. |
| Written argument | An argument or a token already written in the command at the cursor, with its call site, text, range and the places it is in. It replaces reading the syntax tree. |
| Place (ancestor) | A call site with the offset it starts at: one written thing that contains others, such as one function call or one map. A place is `open` when the cursor is still inside it. |
| Follower | A token the grammar allows next. |
| Token class | What kind of token a follower or a written token is, derived from the grammar: `keyword`, `operator`, `separator`, `opener`, `closer`, `pipe`, `terminator`, `value`, `end`. |
| Word | What is being typed at the cursor, and whether it is already a whole token. |
| Previous, next | The token before the cursor and the first one after it. |
| Enclosing commands, nesting | The commands the cursor's command is inside of: a branch, a subquery. |

**What it means (resolve)**

| Word | Meaning |
| --- | --- |
| Role | What an argument means in the language: a column of some types, a new name, an entity, a constant, a map, an expression. The grammar cannot say this. |
| Role kind | The closed list of roles: `column`, `new_name`, `entity`, `constant`, `option_name`, `map`, `expression`, `dependent_value`, `parameter`, `sublanguage`. |
| Signature | The roles of one command, keyed by call site. The only thing written per command. |
| Default role | The role an argument gets with no signature, from its grammar rule. It is why a new command works before it is described. |
| Inherited | A field of a role that an argument takes from a role above it on its path (the index mode of a list of sources). |
| Dependent value | A value whose role depends on a name written before it (the value of a setting). |
| Expression entry | The call site where a whole expression starts. An expression is offered as one thing, whatever the cursor is nested in. |
| Expression part | What a call site inside an expression is: a column, a function name, a map key, the name of a lambda parameter. Described once, for all commands. |
| Mode | The kind of expression a role asks for: scalar, aggregation, grouping, filter, constant, full text. It decides which functions apply. |
| Sublanguage | A body in another language inside a command (PromQL). The engine hands it over whole. |
| Request | What `resolve` asks for at the cursor: the names of commands, a token, the end of the command, an argument with its role, an expression with its role. |

**What is offered (provide, present)**

| Word | Meaning |
| --- | --- |
| Provider | The function that makes the items of one kind of request or role. There is one per kind and none per command. |
| Context | What a provider knows besides its request: the IR, the columns of the query before the cursor, the editor's callbacks, the license. |
| Entity | A named thing that exists outside the query: a source, an enrich policy, a lookup index, an inference endpoint, a setting, a metadata field. |
| Entity definition | How the entities of one kind are listed (`fetch`), with optional `children`, `actions` and `valueRoles`. One per kind, in `entities/registry.ts`. |
| Scope | What narrows the entities at the cursor: the index mode, the parent's name, inside a subquery, serverless. |
| Action | Something the editor can do where an entity is expected, offered as an item (the browser of data sources). |
| Expression position | Where the cursor is inside an expression: the start of an operand, after an operand, after an operator, in a string. Read from the written arguments. |
| Decision | The rule that picks the items for one expression position. |
| Presentation | How an item looks and what it inserts: the text of a keyword with what must follow it, suggested values, snippets. Data in `presentation.ts`, rules in `providers/tokens.ts`. |
| Follow-up | What is offered on a word that is already whole: the word together with what can come after it. |
| Extras | Items that are not part of the grammar (recommended queries). |
| Override | A provider registered for one argument by hand, in `overrides.ts`. The exception, counted by a test. |

**Tests**

| Word | Meaning |
| --- | --- |
| Scenario row | One query with a cursor and the items expected there, in a command's `autocomplete.scenarios.ts`. Rows run through `suggest`, so they hold for either flow. |
| Parity | The number of scenario rows on which the new flow gives what the current flow gives. |
| `new` row | A row for a behaviour only the new flow has, accepted on purpose. It is skipped for the current flow. |
| Conformance | A test that the grammar side says the right thing, with no suggestion involved. |
| Boundary test | The test that keeps command names and command folders out of the engine, and Kibana out of the simulated packages. |
