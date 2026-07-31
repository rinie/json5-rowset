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

// Scans a JSON5 object literal's top level into an ordered list of
// { key, valueText } entries *without* collapsing duplicate keys the way
// JSON5.parse (and plain JS object literals) would - last-key-wins is
// exactly what parseRowsetGrouped needs to not do. Only the top level is
// scanned by hand; each entry's value text is still handed to
// JSON5.parse individually, so nested object/array/string/comment syntax
// is fully JSON5, not reimplemented here.
function scanJson5TopLevelEntries(text) {
  let i = 0;
  const n = text.length;
  const skipWs = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i += 1;
      } else if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i += 2;
      } else {
        break;
      }
    }
  };

  skipWs();
  if (text[i] !== '{') {
    throw new Error('Invalid json5-rowset grouped notation: expected an object literal');
  }
  i += 1;

  const entries = [];
  for (;;) {
    skipWs();
    if (text[i] === '}') { i += 1; break; }

    let key;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      while (j < n && text[j] !== quote) j += (text[j] === '\\' ? 2 : 1);
      key = JSON5.parse(text.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      key = text.slice(i, j);
      i = j;
    }

    skipWs();
    if (text[i] !== ':') {
      throw new Error(`Invalid json5-rowset grouped notation: expected ":" after key "${key}"`);
    }
    i += 1;
    skipWs();

    const valueStart = i;
    let depth = 0;
    let inStr = null;
    while (i < n) {
      const c = text[i];
      if (inStr) {
        i += (c === '\\' ? 2 : 1);
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") { inStr = c; i += 1; } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i += 1;
      } else if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i += 2;
      } else if (c === '{' || c === '[') { depth += 1; i += 1; } else if (c === '}' || c === ']') {
        if (depth === 0) break;
        depth -= 1; i += 1;
      } else if (c === ',' && depth === 0) {
        break;
      } else {
        i += 1;
      }
    }

    entries.push({ key, value: JSON5.parse(text.slice(valueStart, i).trim()) });
    skipWs();
    if (text[i] === ',') { i += 1; } else if (text[i] === '}') { i += 1; break; }
  }
  return entries;
}

// One json5-rowset text: the same per-table { header, data } shape
// parseRowsetNested uses, except a table name may appear more than once
// - a later occurrence just needs `data` (no `header`), and its rows are
// appended to whatever that table's header/data already were. This is
// the shape for hand-written master/detail exports (order header +
// lines, repeated once per order) where re-typing the column names for
// every order would be pure noise. Declaring every table's header up
// front, each with its own single occurrence, works too - it's just the
// degenerate case where nothing repeats.
//   {
//     orderHeader: { header: ['orderId', 'customer'], data: [[1, 'Acme']] },
//     orderLines: { header: ['orderId', 'sku', 'qty'], data: [[1, 'WIDGET-1', 3], [1, 'WIDGET-2', 1]] },
//     orderHeader: { data: [[2, 'Globex']] },
//     orderLines: { data: [[2, 'GADGET-9', 5]] },
//   }
//   -> [
//        { name: 'orderHeader', header: ['orderId', 'customer'], data: [[1, 'Acme']] },
//        { name: 'orderLines', header: [...], data: [[1, 'WIDGET-1', 3], [1, 'WIDGET-2', 1]] },
//        { name: 'orderHeader', header: ['orderId', 'customer'], data: [[2, 'Globex']] },
//        { name: 'orderLines', header: [...], data: [[2, 'GADGET-9', 5]] },
//      ]
// Unlike parseRowsetGrouped (which merges same-name entries into one
// table), this keeps every entry separate, in document order, with its
// header resolved even when the entry itself only supplied data - e.g.
// to walk order header/lines pairs in the order they were written and
// insert each into Oracle as its own executeMany()/execute() call
// (header rows before their lines, for FK ordering), without first
// merging everything into one giant per-table batch.
// header can be anything parseRowset/parseRowsetNested accept there too
// - plain column names or Oracle metaData-shaped objects - it's never
// guessed at by shape, only ever read from an explicit `header` key.
function parseRowsetGroupedEntries(text) {
  const scanned = scanJson5TopLevelEntries(text);
  const headers = {};
  return scanned.map(({ key: name, value: entry }, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid json5-rowset grouped notation: "${name}" entry ${i} must be an object of { header?, data? }`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'header')) {
      headers[name] = entry.header;
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'data')) {
      throw new Error(`Invalid json5-rowset grouped notation: "${name}" entry ${i} is missing "data"`);
    }
    if (!headers[name]) {
      throw new Error(`Invalid json5-rowset grouped notation: "${name}" data in entry ${i} appears before its header`);
    }
    return { name, header: headers[name], data: entry.data };
  });
}

// Same { name: {header, data} } shape parseRowsetTables/parseRowsetNested
// return - parseRowsetGroupedEntries's entries merged by name, data from
// every entry sharing a name concatenated in document order. Use this
// when you just want the final per-table rowsets and don't care about
// original block order; use parseRowsetGroupedEntries when you do (e.g.
// driving Oracle inserts in the order the groups were written).
function parseRowsetGrouped(text) {
  const tables = {};
  parseRowsetGroupedEntries(text).forEach(({ name, header, data }) => {
    if (!tables[name]) tables[name] = { header, data: [] };
    tables[name].header = header;
    tables[name].data.push(...data);
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

// Inverse of parseRowsetGrouped: { orderHeader: {header,data}, orderLines: {header,data} }
// -> one json5-rowset grouped text.
//   opts.groups: reproduce a specific interleaving (e.g. real
//     master/detail groups) as an array of per-group row counts, e.g.
//     [{ orderHeader: 1, orderLines: 2 }, { orderHeader: 1, orderLines: 1 }]
//     for two orders, the first with 2 lines and the second with 1. Each
//     table's rows are consumed off its data array in that order, and
//     emitted as its own `name: { data: [...] }` entry - the first entry
//     for a given name also carries its `header`, later ones don't (and
//     the table name repeats, same as parseRowsetGrouped expects).
//   Without opts.groups: no interleaving info to reconstruct, so every
//     table gets exactly one `name: { header, data }` entry (its header
//     plus all of its data), in Object.keys(tables) order - always
//     valid, just not grouped - the same output stringifyRowsetNested
//     would produce.
function stringifyRowsetGrouped(tables, opts) {
  const { indent = '  ', groups } = opts || {};
  const idKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : toJsLiteral(k));
  const names = Object.keys(tables);
  const headerEmitted = {};
  const entries = []; // { name, header?, data }

  const pushEntry = (name, data) => {
    const entry = { name, data };
    if (!headerEmitted[name]) {
      entry.header = tables[name].header;
      headerEmitted[name] = true;
    }
    entries.push(entry);
  };

  if (groups) {
    const cursor = {};
    names.forEach((name) => { cursor[name] = 0; });
    groups.forEach((group) => {
      Object.keys(group).forEach((name) => {
        const count = group[name];
        const start = cursor[name];
        pushEntry(name, tables[name].data.slice(start, start + count));
        cursor[name] = start + count;
      });
    });
  } else {
    names.forEach((name) => pushEntry(name, tables[name].data));
  }

  const lines = entries.map((e) => {
    const inner = `${indent}${indent}`;
    const body = [];
    if (e.header) body.push(`${inner}header: [${e.header.map(toJsLiteral).join(', ')}],`);
    body.push(`${inner}data: [`);
    e.data.forEach((row) => body.push(`${inner}${indent}[${row.map(toJsLiteral).join(', ')}],`));
    body.push(`${inner}],`);
    return [`${indent}${idKey(e.name)}: {`, ...body, `${indent}},`].join('\n');
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
  parseRowsetGrouped,
  parseRowsetGroupedEntries,
  stringifyRowset,
  stringifyRowsetTables,
  stringifyRowsetNested,
  stringifyRowsetGrouped,
  rowsetToJson,
  objectsToJson,
};
