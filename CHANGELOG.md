# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `parseRowsetGrouped(text)` / `stringifyRowsetGrouped(tables, opts?)` —
  a grouped/interleaved multi-table text shape (nicknamed "json-DRY") for
  master/detail data: a table name may repeat, with later occurrences
  carrying only `data` (no `header`), appended to what's already there.
- `parseRowsetGroupedEntries(text)` — the same grouped text, returned as
  the raw ordered entry list instead of merged by name, for callers
  where block order itself matters (e.g. driving Oracle inserts so order
  header rows land before their lines, for FK ordering).
- `projectRowsetColumns(rowset, order)` — reorder/subset a rowset's
  columns by name, for bind-by-position calls whose parameter order
  doesn't match the data's own column order (e.g. an Oracle stored
  procedure whose signature may reorder in a future release). Throws on
  an unknown column instead of silently binding `undefined`.
- README "Oracle: loading a grouped rowset in document order" recipe,
  combining the three functions above into an `executeMany()`/`execute()`
  dispatch loop.
- MIT `LICENSE`, GitHub repo description/topics, and branch protection
  (PR required, no force-push/deletion) on `main`.
- Expanded `.gitignore` and an MIT license badge in the README.
- `bindDefsFromRowset(rowset, {oracledb, overrides?})` — infers a
  node-oracledb `executeMany()` bindDef (type, and `maxSize` for
  strings) per header column by scanning every row, or uses a
  metaData-/bindDef-shaped header entry as-is; never depends on
  `oracledb` itself, takes the caller's own module reference to read its
  type constants.
- `toExecuteManyBinds(rowset, {mode})` / `toExecuteManyArgs(rowset, opts)`
  — `rowset.data` (or `rowsetToObjects(rowset)` for named binds) as the
  `binds` argument, and a one-call convenience returning
  `{binds, options: {bindDefs, ...}}` ready to spread into
  `connection.executeMany(sql, binds, options)`.
- `inferBindType(values, oracledb)` / `isPlainObject(v)` /
  `columnValues(rowset, colIndex)` — the smaller pieces the above is
  built from, exported standalone.

## [0.1.0]

### Added

- Initial release: `header`/`data` JSON5 rowset notation with converters
  for node-oracledb's `OUT_FORMAT_ARRAY`/`OUT_FORMAT_OBJECT` row shapes,
  plain JSON array-of-objects, and flat/nested multi-table text shapes.
