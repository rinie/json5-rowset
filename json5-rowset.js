'use strict';

// json5-rowset: compact header/data notation for tabular JS/JSON5 data.
//
// Shape:
//   {
//     header: ['species', 'culmen_length_mm', 'flipper_length_mm'],
//     data: [
//       ['Adelie', 39.1, 181],
//       ['Gentoo', 46.1, 211],
//     ],
//   }
//
// header entries can be either plain names or Oracle-metaData-shaped
// objects ({ name, dbTypeName, precision, scale, nullable, ... }) -
// anything with a .name property. columnName()/isMetadataHeader() below
// are the seam that lets the rest of the module not care which one it got.
//
// Bridges node-oracledb's two row shapes (OUT_FORMAT_ARRAY / OUT_FORMAT_OBJECT)
// and plain JSON (array-of-objects) through one small waterline.

const JSON5 = require('json5');

// Extract the plain name whether a header entry is a string or a
// metaData-shaped object.
function columnName(col) {
  return typeof col === 'string' ? col : col.name;
}

// Oracle stores *unquoted* identifiers upper-case (its own default); a
// name that isn't all-caps-and-underscores must have been created quoted,
// so it's left untouched either way. columnCase:
//   'preserve' (default) - exactly what Oracle/oracledb returned
//   'lower'              - map only the unquoted-looking (ALL_CAPS) names
//                          to lower_case, same heuristic duckdb-oracle uses
function mapColumnCase(name, columnCase) {
  if (columnCase === 'lower' && /^[A-Z_][A-Z0-9_]*$/.test(name)) {
    return name.toLowerCase();
  }
  return name;
}

function mapHeaderCase(header, columnCase) {
  if (!columnCase || columnCase === 'preserve') return header;
  return header.map((col) => (typeof col === 'string'
    ? mapColumnCase(col, columnCase)
    : { ...col, name: mapColumnCase(col.name, columnCase) }));
}

// array-of-objects -> hd. header order/shape is taken from the first
// row's keys unless an explicit header (array of names, or of
// metaData-shaped objects) is passed in.
function objectsToRowset(rows, header) {
  if (!rows || rows.length === 0) {
    return { header: header || [], data: [] };
  }
  const cols = header || Object.keys(rows[0]);
  const data = rows.map((row) => cols.map((col) => row[columnName(col)]));
  return { header: cols, data };
}

// hd -> array-of-objects (e.g. to match node-oracledb OUT_FORMAT_OBJECT,
// or to hand off as plain JSON to a frontend).
function rowsetToObjects(hd) {
  const { header, data } = hd;
  return data.map((row) => {
    const obj = {};
    header.forEach((col, i) => {
      obj[columnName(col)] = row[i];
    });
    return obj;
  });
}

// node-oracledb execute() result with outFormat: oracledb.OUT_FORMAT_ARRAY
// -> hd. Column order/values come straight from result.rows, so this is a
// near-zero-cost wrap.
//   opts.header: 'names' (default) -> header: ['SPECIES', ...]
//                'metadata'        -> header: [{ name: 'SPECIES', ... }, ...]
//   opts.columnCase: 'preserve' (default) | 'lower'
function oracleArrayResultToRowset(result, opts) {
  const { header = 'names', columnCase = 'preserve' } = opts || {};
  const meta = mapHeaderCase(result.metaData, columnCase);
  return {
    header: header === 'metadata' ? meta : meta.map((m) => m.name),
    data: result.rows,
  };
}

// node-oracledb execute() result with outFormat: oracledb.OUT_FORMAT_OBJECT
// -> hd. Row objects are keyed by Oracle's raw (unmapped) names, so those
// raw names drive the lookup regardless of what the *output* header looks
// like; opts.header/opts.columnCase only affect what's in hd.header.
//   opts.header: 'names' (default) | 'metadata' | explicit array override
//   opts.columnCase: 'preserve' (default) | 'lower'
function oracleObjectResultToRowset(result, opts) {
  const { header = 'names', columnCase = 'preserve' } = opts || {};
  const rawNames = result.metaData
    ? result.metaData.map((m) => m.name)
    : (result.rows[0] ? Object.keys(result.rows[0]) : []);

  // Explicit header override: select/reorder columns by that header's
  // (raw, pre-case-mapping) names, then apply columnCase to what's emitted.
  if (Array.isArray(header)) {
    const lookupNames = header.map(columnName);
    const data = result.rows.map((row) => lookupNames.map((name) => row[name]));
    return { header: mapHeaderCase(header, columnCase), data };
  }

  const data = result.rows.map((row) => rawNames.map((name) => row[name]));
  const meta = result.metaData || rawNames.map((name) => ({ name }));
  const mappedMeta = mapHeaderCase(meta, columnCase);
  return {
    header: header === 'metadata' ? mappedMeta : mappedMeta.map((m) => m.name),
    data,
  };
}

// json5-rowset text (JSON5, so comments/trailing commas/unquoted keys are fine)
// -> hd object, with a light shape check.
//   opts.headerKey / opts.dataKey: rename the two properties, e.g.
//   { headerKey: 'csvHeader', dataKey: 'csvData' } to read
//   { csvHeader: [...], csvData: [...] }. Defaults to 'header'/'data'.
// The returned hd object always uses the plain 'header'/'data' keys
// internally, regardless of what the source text called them.
function parseRowset(text, opts) {
  const { headerKey = 'header', dataKey = 'data' } = opts || {};
  const parsed = JSON5.parse(text);
  const header = parsed[headerKey];
  const data = parsed[dataKey];
  if (!Array.isArray(header) || !Array.isArray(data)) {
    throw new Error(`Invalid json5-rowset notation: expected { ${headerKey}: [...], ${dataKey}: [...] }`);
  }
  return { header, data };
}

// One json5-rowset text -> multiple named tables, auto-detected by camelCase
// `<name>Header` / `<name>Data` key pairs (e.g. csvHeader/csvData,
// penguinsHeader/penguinsData). Plain `header`/`data` (no prefix) is
// picked up too, under the name 'default'.
//   { csvHeader: [...], csvData: [...], weatherHeader: [...], weatherData: [...] }
//   -> { csv: { header, data }, weather: { header, data } }
function parseRowsetTables(text) {
  const parsed = JSON5.parse(text);
  const tables = {};
  Object.keys(parsed).forEach((key) => {
    const m = /^(.*)Header$/.exec(key);
    if (!m) return;
    const name = m[1] || 'default';
    const dataKey = `${m[1]}Data`;
    if (!Array.isArray(parsed[key]) || !Array.isArray(parsed[dataKey])) return;
    tables[name] = { header: parsed[key], data: parsed[dataKey] };
  });
  return tables;
}

// One json5-rowset text, tables nested per name instead of flattened by prefix:
//   { penguins: { header: [...], data: [...] }, weather: { header: [...], data: [...] } }
//   -> { penguins: { header, data }, weather: { header, data } }
// This is the more natural JSON5 shape when you don't need the keys to
// stay single-level identifiers - each table is just an hd object keyed
// by its name.
function parseRowsetNested(text) {
  const parsed = JSON5.parse(text);
  const tables = {};
  Object.keys(parsed).forEach((name) => {
    const hd = parsed[name];
    if (!hd || !Array.isArray(hd.header) || !Array.isArray(hd.data)) return;
    tables[name] = { header: hd.header, data: hd.data };
  });
  return tables;
}

// Minimal single-line JS-literal writer, used for both header entries
// (which may be plain strings or metaData-shaped objects) and row values.
function toJsLiteral(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(toJsLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const body = Object.keys(value)
      .map((k) => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : toJsLiteral(k)}: ${toJsLiteral(value[k])}`)
      .join(', ');
    return `{ ${body} }`;
  }
  return String(value); // number, boolean
}

// hd -> compact json5-rowset text: one line for the header, one line per data row.
// This is the thing you'd actually check into git next to a report .md or
// a fixture file — diffs stay one-line-per-row instead of JSON.stringify's
// one-line-per-value.
//   opts.headerKey / opts.dataKey: property names to emit, default
//   'header'/'data'. Both are written unquoted whenever they're valid bare
//   identifiers (true for 'header'/'data' and for camelCase names like
//   'csvHeader'/'csvData'; a name with e.g. a hyphen would get quoted).
function stringifyRowset(hd, opts) {
  const { indent = '  ', headerKey = 'header', dataKey = 'data' } = opts || {};
  const idKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : toJsLiteral(k));
  const headerLine = `${indent}${idKey(headerKey)}: [${hd.header.map(toJsLiteral).join(', ')}],`;
  const dataLines = hd.data.map(
    (row) => `${indent}${indent}[${row.map(toJsLiteral).join(', ')}],`,
  );
  return ['{', headerLine, `${indent}${idKey(dataKey)}: [`, ...dataLines, `${indent}],`, '}'].join('\n');
}

// Inverse of parseRowsetTables: { csv: {header,data}, weather: {header,data} }
// -> one json5-rowset text with csvHeader/csvData/weatherHeader/weatherData keys.
// A table named 'default' is emitted as plain header/data (no prefix).
function stringifyRowsetTables(tables, opts) {
  const { indent = '  ' } = opts || {};
  const idKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : toJsLiteral(k));
  const lines = [];
  Object.keys(tables).forEach((name) => {
    const hd = tables[name];
    const prefix = name === 'default' ? '' : name;
    const headerKey = prefix ? `${prefix}Header` : 'header';
    const dataKey = prefix ? `${prefix}Data` : 'data';
    lines.push(`${indent}${idKey(headerKey)}: [${hd.header.map(toJsLiteral).join(', ')}],`);
    lines.push(`${indent}${idKey(dataKey)}: [`);
    hd.data.forEach((row) => lines.push(`${indent}${indent}[${row.map(toJsLiteral).join(', ')}],`));
    lines.push(`${indent}],`);
  });
  return ['{', ...lines, '}'].join('\n');
}

// Inverse of parseRowsetNested: { penguins: {header,data}, weather: {header,data} }
// -> one json5-rowset text with each table nested under its own name key.
function stringifyRowsetNested(tables, opts) {
  const { indent = '  ' } = opts || {};
  const idKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : toJsLiteral(k));
  const lines = [];
  const names = Object.keys(tables);
  names.forEach((name) => {
    const hd = tables[name];
    const inner = `${indent}${indent}`;
    lines.push(`${indent}${idKey(name)}: {`);
    lines.push(`${inner}header: [${hd.header.map(toJsLiteral).join(', ')}],`);
    lines.push(`${inner}data: [`);
    hd.data.forEach((row) => lines.push(`${inner}${indent}[${row.map(toJsLiteral).join(', ')}],`));
    lines.push(`${inner}],`);
    lines.push(`${indent}},`);
  });
  return ['{', ...lines, '}'].join('\n');
}

// hd -> plain JSON, keeping the compact {header, data} shape (smallest
// wire format — good for bulk export/import).
function rowsetToJson(hd) {
  return JSON.stringify(hd);
}

// hd -> plain JSON, expanded to array-of-objects (good for a frontend
// that just wants normal row objects, or for diffing against Oracle
// OUT_FORMAT_OBJECT output).
function objectsToJson(hd) {
  return JSON.stringify(rowsetToObjects(hd));
}

module.exports = {
  columnName,
  mapColumnCase,
  objectsToRowset,
  rowsetToObjects,
  oracleArrayResultToRowset,
  oracleObjectResultToRowset,
  parseRowset,
  parseRowsetTables,
  parseRowsetNested,
  stringifyRowset,
  stringifyRowsetTables,
  stringifyRowsetNested,
  rowsetToJson,
  objectsToJson,
};
