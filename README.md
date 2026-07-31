# json5-rowset

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Compact `header`/`data` JSON5 rowset notation for tabular data, plus
converters that bridge it to node-oracledb's two row formats and to
plain JSON.

```js
{
  header: ['species', 'culmen_length_mm', 'culmen_depth_mm', 'flipper_length_mm'],
  data: [
    ['Adelie', 39.1, 18.7, 181],
    ['Gentoo', 46.1, 13.2, 211],
  ],
}
```

`header` is names once; `data` is values only, one row per line. Diffs
stay one-line-per-row (unlike `JSON.stringify`'s one-line-per-value), and
because it's parsed as JSON5 (not strict JSON) it can be hand-edited with
comments and trailing commas.

Internally, and throughout this README, that `{header, data}` shape is
called a **rowset**.

## Why

node-oracledb gives you rows two ways:

- `outFormat: oracledb.OUT_FORMAT_ARRAY` — each row is `['Adelie', 39.1]`,
  column names live once in `result.metaData`
- `outFormat: oracledb.OUT_FORMAT_OBJECT` — each row is
  `{ SPECIES: 'Adelie', CULMEN_LENGTH_MM: 39.1 }`, column names repeated
  on every row

json5-rowset is that same array-format shape, addressable as a small
piece of JSON5 you can read, hand-write, diff, or check into git next to
a fixture/report — with functions to go from either Oracle result shape
into it and back out to plain JSON (compact or expanded to
array-of-objects) on demand.

## Install

```
npm install
```

## API

### Core conversions

- `objectsToRowset(rows, header?)` — array-of-objects → `{header, data}`.
  `header` (array of names, or of `{name, ...}` objects) is optional;
  defaults to the first row's key order.
- `rowsetToObjects(rowset)` — `{header, data}` → array-of-objects.
- `columnName(col)` — get the plain name whether `col` is a string or a
  `{name, ...}` object. Used internally, exported in case you're writing
  more converters against the same header shape.

### node-oracledb bridges

- `oracleArrayResultToRowset(result, opts?)` — `OUT_FORMAT_ARRAY` result
  → rowset. Zero-copy on `data` (`result.rows` is reused directly).
- `oracleObjectResultToRowset(result, opts?)` — `OUT_FORMAT_OBJECT`
  result → rowset.

Both take:

- `opts.header`: `'names'` (default, `header: ['SPECIES', ...]`) |
  `'metadata'` (`header: [{name: 'SPECIES', dbTypeName: 'VARCHAR2', ...}, ...]`,
  full `result.metaData` entries) | an explicit array (names or metadata
  objects) to select/reorder columns — only on `oracleObjectResultToRowset`.
- `opts.columnCase`: `'preserve'` (default, exactly what Oracle/oracledb
  returned) | `'lower'` — lowercases only the unquoted-looking
  (`ALL_CAPS`) names, same heuristic as `duckdb-oracle`; a name that
  isn't all-caps must have been created quoted, so it's left alone.

### json5-rowset text (single table)

- `parseRowset(text, opts?)` — json5-rowset text → rowset.
- `stringifyRowset(rowset, opts?)` — rowset → json5-rowset text, one row
  per line.

Both take `opts.headerKey`/`opts.dataKey` (default `'header'`/`'data'`)
to rename the two properties, e.g. `{headerKey: 'csvHeader', dataKey: 'csvData'}`
to read/write `{ csvHeader: [...], csvData: [...] }`. The in-memory
rowset object always uses plain `header`/`data`, regardless of what the
source text called them.

### json5-rowset text (multiple tables)

Two interchangeable shapes for holding several tables in one file:

**Flat, prefixed keys** — `<name>Header`/`<name>Data` pairs, auto-detected:

```js
{
  csvHeader: [...], csvData: [...],
  weatherHeader: [...], weatherData: [...],
}
```
- `parseRowsetTables(text)` → `{ csv: {header, data}, weather: {header, data} }`
- `stringifyRowsetTables(tables, opts?)` → the inverse

**Nested, one block per name** — the more natural JSON5 shape:

```js
{
  penguins: { header: [...], data: [...] },
  weather:  { header: [...], data: [...] },
}
```
- `parseRowsetNested(text)` → `{ penguins: {header, data}, weather: {header, data} }`
- `stringifyRowsetNested(tables, opts?)` → the inverse

### json5-rowset text (grouped / interleaved tables — "json-DRY")

For master/detail data — an order header plus its lines, repeated once
per order — repeating the column names for every order is pure noise.
The grouped shape is the same per-table `{ header, data }` object
`parseRowsetNested` uses, except a table name is allowed to repeat: a
later occurrence only needs `data` (no `header`), and its rows are
appended to that table. Declaring every table's header up front, each
with its own single occurrence, works too — it's just the degenerate
case where nothing repeats.

```js
{
  orderHeader: {
    header: ['orderId', 'customer', 'orderDate'],
    data: [[1, 'Acme', '2026-07-01']],
  },
  orderLines: {
    header: ['orderId', 'lineNo', 'sku', 'qty'],
    data: [[1, 1, 'WIDGET-1', 3], [1, 2, 'WIDGET-2', 1]],
  },
  orderHeader: { data: [[2, 'Globex', '2026-07-15']] },   // no header redeclared
  orderLines: { data: [[2, 1, 'GADGET-9', 5]] },
}
```

`header` is never guessed at by shape — it's always read from an
explicit `header` key, so it can be plain column names or Oracle
metaData-shaped objects, same as everywhere else in this module. Plain
JS/JSON5 object semantics don't allow this text to just be handed to
`JSON5.parse` as-is, though — a normal object literal treats a repeated
key as last-one-wins and would silently drop the first `orderHeader`
entry. `parseRowsetGrouped` scans the top level itself (handing each
individual entry's value off to `JSON5.parse`) so repeated keys are
appended instead of overwritten.

- `parseRowsetGrouped(text)` → `{ orderHeader: {header, data}, orderLines: {header, data} }`
  — same shape `parseRowsetTables`/`parseRowsetNested` return; data from
  every entry sharing a name is concatenated, in document order.
- `stringifyRowsetGrouped(tables, opts?)` → the inverse. Without
  `opts.groups` it emits exactly one `name: { header, data }` entry per
  table (its header plus all of its data) — always valid, just not
  grouped, and the same output `stringifyRowsetNested` would produce. To
  reproduce a real interleaving, pass `opts.groups` as an array of
  per-group row counts:
  `[{ orderHeader: 1, orderLines: 2 }, { orderHeader: 1, orderLines: 1 }]`
  for two orders, the first with 2 lines and the second with 1 — rows are
  consumed off each table's data in order, each as its own `name: {...}`
  entry; the first entry for a given name also carries its `header`,
  later ones don't.

### Plain JSON

- `rowsetToJson(rowset)` — `JSON.stringify({header, data})`, smallest
  wire size.
- `objectsToJson(rowset)` — `JSON.stringify(rowsetToObjects(rowset))`,
  expanded array-of-objects.

Nested/flat/grouped multi-table objects (from `parseRowsetTables`/
`parseRowsetNested`/`parseRowsetGrouped`) are already plain JS objects of
`{header, data}` — `JSON.stringify(tables)`
works directly with no extra step, and running `rowsetToObjects` per
table first gives the expanded array-of-objects form per table.

## Test

```
npm test
```

`test.js` round-trips every function above (parse ↔ stringify, both
Oracle result shapes converging on the same rowset, all three multi-table
shapes, and the plain-JSON conversions) with `assert.deepStrictEqual`
checks — read it as the spec if anything above is ambiguous.

## Conventions

Node.js/JS only, `.js` file extension (never `.mjs`/`.cjs`), semicolons,
single quotes. Not yet run through `eslint-config-airbnb-extended` — worth
doing before this goes in a shared repo.

## Known gaps / open questions

- `stringifyRowset`/`stringifyRowsetNested`/`stringifyRowsetTables` quote
  every string value; a `NUMBER` column that arrives from Oracle as a
  string (`fetchAsString`, or large numbers past JS's safe-integer range)
  will get quoted like any other string in the json5-rowset text output.
  No special casing for that yet.
- No dedup/intern-pool for repeated string values across rows (discussed
  and deliberately left out — readability was preferred over the extra
  machinery).
- `oracleArrayResultToRowset`'s explicit-header-override (selecting/
  reordering a subset of columns) only exists on
  `oracleObjectResultToRowset`, since `OUT_FORMAT_ARRAY` rows don't carry
  column names per-value to select against. If that's needed for
  `OUT_FORMAT_ARRAY` too, it'd have to select by index against
  `result.metaData` first.
- `parseRowsetGrouped` hand-scans only the *top* level of the object
  literal to preserve duplicate table-name keys (see above); a table
  name repeating inside a nested structure isn't a thing this format
  has a use for, so that's not supported, and there's no plan to.
- No CLI wrapper yet (e.g. `json5-rowset convert file.js --to json`) —
  every entry point above is a function, called from your own script.
