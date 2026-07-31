# CONTEXT: json5-rowset — handover

## What this is

A small, dependency-light (`json5` only) Node.js module: a compact
`header`/`data` JSON5 notation for tabular data — a **rowset** — with
converters to and from node-oracledb's two row formats
(`OUT_FORMAT_ARRAY` / `OUT_FORMAT_OBJECT`) and to plain JSON. Built
conversationally in claude.ai, one feature at a time, each one
hand-tested before moving on. Originally prototyped under the working
name `hd5`; renamed to `json5-rowset` once the shape stabilized — if you
find stray references to `hd5` anywhere outside this handover, that's a
rename miss, not intentional. This handover is so the module can be
turned into a proper standalone repo (own git history, README, CI,
package published or not — your call) without re-deriving the design
decisions from scratch.

## Files in this handover

- `json5-rowset.js` — the module. Single file, no build step.
- `test.js` — plain `node:assert` script, not a test framework. Run with
  `node test.js` or `npm test`. Every function is exercised at least
  once, with round-trip assertions (parse → stringify → parse gives back
  the same object, etc).
- `package.json` — minimal, `json5` as the only dependency.
- `README.md` — user-facing docs, API reference, known gaps. Treat this
  as accurate and current — it was written from the finished code, not
  aspirationally.

## Why this exists (the actual problem)

node-oracledb gives rows two shapes: `OUT_FORMAT_ARRAY` (values only,
column names once in `metaData`) or `OUT_FORMAT_OBJECT` (column names
repeated on every row). Rinie wanted a notation that mirrors the
`OUT_FORMAT_ARRAY` shape but as hand-writable/hand-editable JSON5 — for
fixtures, exports, anything checked into git next to a report — plus
converters so either Oracle result shape (and plain JSON
array-of-objects, for frontend interop) can move losslessly to and from
it.

## Design decisions worth knowing before you touch this

1. **Header entries are either a plain string or a `{name, ...}` object.**
   Never a bare object as the whole `header` value — always an array.
   `columnName(col)` is the one place that distinction is resolved; every
   other function goes through it rather than assuming `typeof header[i]
   === 'string'`.

2. **`columnCase: 'lower'` is a heuristic, not a guarantee.** Oracle
   stores *unquoted* identifiers upper-case. A name that isn't
   `^[A-Z_][A-Z0-9_]*$` must have been created quoted (hence mixed/lower
   case survived), so it's left alone either way. This is the same
   heuristic used in `duckdb-oracle` — don't invent a different one here,
   keep them consistent if either changes.

3. **No string interning / dedup for repeated values.** Explicitly
   discussed and rejected — Rinie prioritized readability of the raw
   JSON5 over a shorter-but-indirected encoding. If someone asks for this
   later, it's a deliberate reversal of a decision, not an oversight.

4. **Three multi-table shapes exist on purpose, not by indecision:** flat
   prefixed keys (`csvHeader`/`csvData`), nested blocks
   (`penguins: {header, data}`), and grouped/interleaved blocks — the
   same `{name: {header, data}}` shape as nested, except a table name may
   repeat, with later occurrences carrying only `data` (nicknamed
   "json-DRY": don't repeat the header). All three round-trip through the
   same in-memory `{name: {header, data}}` object. Keep all three —
   nested is preferred for hand-authoring a small fixed set of tables,
   grouped exists specifically for master/detail data (order header +
   lines, repeated once per order) where a table's header should only
   need to be written once, not for every repetition. Don't remove any
   without asking.

   Grouped's duplicate-key requirement is *why* it can't just be
   `JSON5.parse(text)` like every other parse function here - plain
   JS/JSON5 object literal semantics silently drop earlier duplicate
   keys (last one wins), which would lose data, not just reformat it.
   `parseRowsetGrouped` hand-scans the top level only
   (`scanJson5TopLevelEntries`, not exported) to preserve every
   occurrence in order, then still hands each individual entry's value
   off to `JSON5.parse` - nested syntax (strings, comments, trailing
   commas, arrays/objects) is fully JSON5, not reimplemented. If this
   scanner ever needs to grow (e.g. supporting the same duplicate-key
   trick at a nested level), keep it hand-rolled rather than pulling in a
   JSON5 tokenizer dependency - the `json5` package doesn't expose one
   publicly, and the surface actually needed here (balanced brace/bracket
   + string/comment skipping) is small on purpose.

5. **`stringifyRowset*` always single-quotes string values.** Known gap:
   Oracle `NUMBER` columns fetched as strings (`fetchAsString`, or values
   past JS's safe-integer range) will round-trip as quoted strings in
   json5-rowset text, not bare numbers. Documented in the README under
   "Known gaps", not yet fixed — ask before silently "fixing" this, the
   right behavior depends on how the caller wants big numbers handled.

6. **Naming convention across the API:** every function is named
   `<verb><Shape>`, where shape is `Rowset` (single table) or
   `RowsetTables`/`RowsetNested`/`RowsetGrouped` (multi-table: flat,
   nested, or grouped/interleaved). The one exception is
   `parseRowsetGroupedEntries` - same `Grouped` family, but returns the
   raw ordered entry list instead of the usual `{name: {header, data}}`
   table map, for callers where block order itself is the point (e.g.
   driving Oracle inserts header-before-lines). `parseRowsetGrouped` is
   just that, merged - keep it that way rather than duplicating the
   parsing/validation logic between them. No
   remaining references to the old `hd5`/`Hd5` working name should exist
   in code, comments, or docs — if you spot one, it's a miss from the
   rename, fix it.

## Conventions (Rinie's standing preferences — apply repo-wide)

- Node.js/JavaScript, never Python.
- Always `.js` extension, never `.mjs`/`.cjs`.
- Semicolons always, single quotes, no inline exports — collect at the
  bottom in one `module.exports = { ... }` (already done in
  `json5-rowset.js`, keep it that way as the file grows).
- `eslint-config-airbnb-extended` is the default ESLint config
  (ESLint 9 flat config + TypeScript) elsewhere in Rinie's repos — not
  yet wired up here, worth adding as part of "make this a proper repo."
- `git clone --depth 1` unless history is actually needed (not relevant
  to this handover itself, but standard for pulling in anything else).

## Suggested next steps for turning this into a repo

1. `git init`, commit `json5-rowset.js` + `test.js` + `package.json` +
   `README.md` + this `CONTEXT.md` as the first commit.
2. Wire up `eslint-config-airbnb-extended` (flat config) and fix
   whatever it flags — the code was hand-written conversationally, not
   linted.
3. Decide whether `test.js` stays a plain assert script or gets ported
   to whatever test runner the rest of Rinie's repos use, if there's a
   standard.
4. Address or explicitly punt on the "Known gaps" section in the README
   — particularly the numeric-string quoting issue, since that's the
   one most likely to bite in real Oracle data.
5. Optional: a thin CLI (`json5-rowset convert file.js --to json`) if
   this ends up used outside of being required as a library — not built
   yet, noted as a gap in the README.

## Not yet done / explicitly out of scope for this handover

- No TypeScript types.
- No CLI.
- No publishing to any registry (Verdaccio or otherwise) — this handover
  is source-only.
- No integration wiring into any of Rinie's other repos
  (`duckdb-oracle`, the OpenAPI→Oracle middleware, etc.) — this is a
  standalone utility, integration is a separate task if wanted later.
