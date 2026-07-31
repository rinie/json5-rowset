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

### json5-rowset text (grouped / interleaved tables)

For master/detail data — an order header plus its lines, repeated once
per order — repeating the column names for every order is pure noise.
The grouped shape is an ordered sequence of small blocks, each one a
plain object keyed by table name (like the flat/nested shapes above),
mapping to either that table's header or a chunk of its data. A table's
header only has to appear once, anywhere before its first data entry;
every later data entry for that name just carries rows. Declaring every
header up front (in one shared block, or one each) works too — it's just
the case where every header happens to come first. Since one block can
carry entries for several tables at once, one block can double as one
whole group — an order header row plus its lines, together:

```js
{
  groups: [
    { orderHeader: ['orderId', 'customer'], orderLines: ['orderId', 'sku', 'qty'] },
    { orderHeader: [[1, 'Acme']], orderLines: [[1, 'WIDGET-1', 3], [1, 'WIDGET-2', 1]] },
    { orderHeader: [[2, 'Globex']], orderLines: [[2, 'GADGET-9', 5]] }, // no header redeclared
  ],
}
```

Header vs data is told apart by shape, not by a key name: a header's
entries are column names or metaData-shaped objects, never arrays; a
data entry is always an array of row arrays. (An empty array is treated
as an empty data entry — there's no such thing as a zero-column header.)

- `parseRowsetGrouped(text, opts?)` → `{ orderHeader: {header, data}, orderLines: {header, data} }`
  — same shape `parseRowsetTables`/`parseRowsetNested` return; data from
  every entry sharing a name is concatenated, in document order.
  `opts.groupsKey` renames the top-level `groups` property.
- `stringifyRowsetGrouped(tables, opts?)` → the inverse. Without
  `opts.groups` it just emits each table's header once followed by all
  its data as one block (always valid, not grouped). To reproduce a real
  interleaving, pass `opts.groups` as an array of per-group row counts:
  `[{ orderHeader: 1, orderLines: 2 }, { orderHeader: 1, orderLines: 1 }]`
  for two orders, the first with 2 lines and the second with 1 — rows are
  consumed off each table's data in order, and each group's counts are
  emitted together as one block (one block = one order). `opts.headersAtTop: true`
  emits every header together, up front, in one shared block, instead of
  each right before its first data block.

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
- No CLI wrapper yet (e.g. `json5-rowset convert file.js --to json`) —
  every entry point above is a function, called from your own script.
