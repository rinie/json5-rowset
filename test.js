'use strict';

const assert = require('assert');
const {
  objectsToRowset,
  rowsetToObjects,
  oracleArrayResultToRowset,
  oracleObjectResultToRowset,
  parseRowset,
  parseRowsetTables,
  parseRowsetNested,
  parseRowsetGrouped,
  stringifyRowset,
  stringifyRowsetTables,
  stringifyRowsetNested,
  stringifyRowsetGrouped,
  rowsetToJson,
  objectsToJson,
} = require('./json5-rowset.js');

// 1. json5-rowset source text, JSON5: comments + trailing commas + unquoted keys ok.
const rowsetText = `{
  // penguins subset
  header: ['species', 'culmen_length_mm', 'culmen_depth_mm', 'flipper_length_mm'],
  data: [
    ['Adelie', 39.1, 18.7, 181],
    ['Gentoo', 46.1, 13.2, 211],
  ],
}`;

const hd = parseRowset(rowsetText);
console.log('parsed hd:', hd);

// 2. hd -> array-of-objects (what OUT_FORMAT_OBJECT / a frontend wants)
const objects = rowsetToObjects(hd);
assert.deepStrictEqual(objects[0], {
  species: 'Adelie',
  culmen_length_mm: 39.1,
  culmen_depth_mm: 18.7,
  flipper_length_mm: 181,
});

// 3. array-of-objects -> hd (round trip), explicit column order preserved
const hdBack = objectsToRowset(objects, hd.header);
assert.deepStrictEqual(hdBack, hd);
console.log('round trip objects -> hd OK');

// 4. simulated node-oracledb OUT_FORMAT_ARRAY result, default opts (names, preserve case)
const oracleArrayResult = {
  metaData: [
    { name: 'SPECIES', dbTypeName: 'VARCHAR2' },
    { name: 'CULMEN_LENGTH_MM', dbTypeName: 'NUMBER' },
    { name: 'weirdLowerCol', dbTypeName: 'NUMBER' }, // simulate a quoted-at-creation column
  ],
  rows: [
    ['Adelie', 39.1, 1],
    ['Gentoo', 46.1, 2],
  ],
};

const hdPreserve = oracleArrayResultToRowset(oracleArrayResult);
assert.deepStrictEqual(hdPreserve.header, ['SPECIES', 'CULMEN_LENGTH_MM', 'weirdLowerCol']);
console.log('oracleArrayResultToRowset default (names, preserve):', hdPreserve.header);

// 4b. header: 'metadata' keeps full metaData objects
const hdMetadata = oracleArrayResultToRowset(oracleArrayResult, { header: 'metadata' });
assert.deepStrictEqual(hdMetadata.header[0], { name: 'SPECIES', dbTypeName: 'VARCHAR2' });
console.log('oracleArrayResultToRowset header:metadata:', hdMetadata.header);

// 4c. columnCase: 'lower' only touches ALL_CAPS (unquoted-looking) names
const hdLower = oracleArrayResultToRowset(oracleArrayResult, { columnCase: 'lower' });
assert.deepStrictEqual(hdLower.header, ['species', 'culmen_length_mm', 'weirdLowerCol']);
console.log('oracleArrayResultToRowset columnCase:lower:', hdLower.header);

// combine both: metadata objects with lower-cased names
const hdMetaLower = oracleArrayResultToRowset(oracleArrayResult, { header: 'metadata', columnCase: 'lower' });
assert.strictEqual(hdMetaLower.header[0].name, 'species');
assert.strictEqual(hdMetaLower.header[0].dbTypeName, 'VARCHAR2');
console.log('oracleArrayResultToRowset header:metadata + columnCase:lower:', hdMetaLower.header);

// 5. simulated node-oracledb OUT_FORMAT_OBJECT result - rows keyed by RAW names
const oracleObjectResult = {
  metaData: oracleArrayResult.metaData,
  rows: [
    { SPECIES: 'Adelie', CULMEN_LENGTH_MM: 39.1, weirdLowerCol: 1 },
    { SPECIES: 'Gentoo', CULMEN_LENGTH_MM: 46.1, weirdLowerCol: 2 },
  ],
};

const hdFromObjectPreserve = oracleObjectResultToRowset(oracleObjectResult);
assert.deepStrictEqual(hdFromObjectPreserve, hdPreserve);
console.log('OUT_FORMAT_ARRAY and OUT_FORMAT_OBJECT converge (preserve) OK');

const hdFromObjectLower = oracleObjectResultToRowset(oracleObjectResult, { columnCase: 'lower' });
assert.deepStrictEqual(hdFromObjectLower, hdLower);
console.log('OUT_FORMAT_ARRAY and OUT_FORMAT_OBJECT converge (lower) OK');

// explicit header override (array form) still works
const hdExplicit = oracleObjectResultToRowset(oracleObjectResult, { header: ['SPECIES', 'weirdLowerCol'] });
assert.deepStrictEqual(hdExplicit.data, [['Adelie', 1], ['Gentoo', 2]]);
console.log('explicit header override on OUT_FORMAT_OBJECT OK');

// 6. hd -> compact json5-rowset text (round trips through parseRowset again), incl. metadata header
const roundTripText = stringifyRowset(hd);
const reparsed = parseRowset(roundTripText);
assert.deepStrictEqual(reparsed, hd);
console.log('round trip hd -> json5-rowset text -> hd OK');

const metaRoundTripText = stringifyRowset(hdMetaLower);
console.log('stringifyRowset with metadata header:\n', metaRoundTripText);
const metaReparsed = parseRowset(metaRoundTripText);
assert.deepStrictEqual(metaReparsed, hdMetaLower);
console.log('round trip metadata-header hd -> json5-rowset text -> hd OK');

// 7. on-the-fly conversion to plain JSON, both shapes
console.log('rowsetToJson:', rowsetToJson(hd));
console.log('objectsToJson:', objectsToJson(hd));

// 8. renamed identifiers: csvHeader / csvData instead of header / data
const csvText = `{
  csvHeader: ['species', 'culmen_length_mm'],
  csvData: [
    ['Adelie', 39.1],
    ['Gentoo', 46.1],
  ],
}`;
const hdFromCsv = parseRowset(csvText, { headerKey: 'csvHeader', dataKey: 'csvData' });
assert.deepStrictEqual(hdFromCsv, { header: ['species', 'culmen_length_mm'], data: [['Adelie', 39.1], ['Gentoo', 46.1]] });
console.log('parseRowset with csvHeader/csvData OK');

const csvBackText = stringifyRowset(hdFromCsv, { headerKey: 'csvHeader', dataKey: 'csvData' });
console.log('stringifyRowset with csvHeader/csvData:\n', csvBackText);
assert.deepStrictEqual(parseRowset(csvBackText, { headerKey: 'csvHeader', dataKey: 'csvData' }), hdFromCsv);
console.log('round trip csvHeader/csvData -> hd -> csvHeader/csvData OK');

// 9. multi-table: several <name>Header/<name>Data pairs in one json5-rowset text
const multiText = `{
  csvHeader: ['species', 'culmen_length_mm'],
  csvData: [['Adelie', 39.1], ['Gentoo', 46.1]],
  weatherHeader: ['date', 'temp_c'],
  weatherData: [['2026-01-01', 3.2]],
}`;
const tables = parseRowsetTables(multiText);
assert.deepStrictEqual(Object.keys(tables).sort(), ['csv', 'weather']);
assert.deepStrictEqual(tables.csv, hdFromCsv);
assert.deepStrictEqual(tables.weather, { header: ['date', 'temp_c'], data: [['2026-01-01', 3.2]] });
console.log('parseRowsetTables OK:', Object.keys(tables));

const multiBackText = stringifyRowsetTables(tables);
console.log('stringifyRowsetTables:\n', multiBackText);
assert.deepStrictEqual(parseRowsetTables(multiBackText), tables);
console.log('round trip multi-table json5-rowset text OK');

// 10. nested multi-table shape: { penguins: {header,data}, weather: {header,data} }
const nestedText = `{
  penguins: {
    header: ['species', 'culmen_length_mm'],
    data: [['Adelie', 39.1], ['Gentoo', 46.1]],
  },
  weather: {
    header: ['date', 'temp_c'],
    data: [['2026-01-01', 3.2]],
  },
}`;
const nestedTables = parseRowsetNested(nestedText);
assert.deepStrictEqual(Object.keys(nestedTables).sort(), ['penguins', 'weather']);
assert.deepStrictEqual(nestedTables.penguins, hdFromCsv);
assert.deepStrictEqual(nestedTables.weather, { header: ['date', 'temp_c'], data: [['2026-01-01', 3.2]] });
console.log('parseRowsetNested OK:', Object.keys(nestedTables));

const nestedBackText = stringifyRowsetNested(nestedTables);
console.log('stringifyRowsetNested:\n', nestedBackText);
assert.deepStrictEqual(parseRowsetNested(nestedBackText), nestedTables);
console.log('round trip nested json5-rowset text OK');

// 11. grouped multi-table shape: interleaved master/detail blocks, header
// declared once per table, later blocks for the same table are data-only
const groupedText = `{
  groups: [
    { name: 'orderHeader', header: ['orderId', 'customer'] },
    { name: 'orderLines', header: ['orderId', 'sku', 'qty'] },
    { name: 'orderHeader', data: [[1, 'Acme']] },
    { name: 'orderLines', data: [[1, 'WIDGET-1', 3], [1, 'WIDGET-2', 1]] },
    { name: 'orderHeader', data: [[2, 'Globex']] }, // no header redeclared
    { name: 'orderLines', data: [[2, 'GADGET-9', 5]] },
  ],
}`;
const groupedTables = parseRowsetGrouped(groupedText);
assert.deepStrictEqual(Object.keys(groupedTables).sort(), ['orderHeader', 'orderLines']);
assert.deepStrictEqual(groupedTables.orderHeader, {
  header: ['orderId', 'customer'],
  data: [[1, 'Acme'], [2, 'Globex']],
});
assert.deepStrictEqual(groupedTables.orderLines, {
  header: ['orderId', 'sku', 'qty'],
  data: [[1, 'WIDGET-1', 3], [1, 'WIDGET-2', 1], [2, 'GADGET-9', 5]],
});
console.log('parseRowsetGrouped OK:', Object.keys(groupedTables));

// a data block for a name with no header yet is rejected
assert.throws(() => parseRowsetGrouped(`{ groups: [{ name: 'x', data: [[1]] }] }`), /before its header/);
console.log('parseRowsetGrouped rejects data before header OK');

// 11b. stringifyRowsetGrouped without opts.groups: header once + one combined data block per table
const groupedBackText = stringifyRowsetGrouped(groupedTables);
console.log('stringifyRowsetGrouped (ungrouped):\n', groupedBackText);
assert.deepStrictEqual(parseRowsetGrouped(groupedBackText), groupedTables);
console.log('round trip grouped (ungrouped) json5-rowset text OK');

// 11c. stringifyRowsetGrouped with opts.groups: reproduces the original master/detail interleaving
const groupedInterleavedText = stringifyRowsetGrouped(groupedTables, {
  groups: [
    { orderHeader: 1, orderLines: 2 },
    { orderHeader: 1, orderLines: 1 },
  ],
});
console.log('stringifyRowsetGrouped (interleaved):\n', groupedInterleavedText);
assert.deepStrictEqual(parseRowsetGrouped(groupedInterleavedText), groupedTables);
console.log('round trip grouped (interleaved) json5-rowset text OK');

// 11d. opts.headersAtTop: all headers emitted before any data, still round trips
const groupedHeadersAtTopText = stringifyRowsetGrouped(groupedTables, {
  groups: [{ orderHeader: 1, orderLines: 2 }, { orderHeader: 1, orderLines: 1 }],
  headersAtTop: true,
});
assert.deepStrictEqual(parseRowsetGrouped(groupedHeadersAtTopText), groupedTables);
console.log('round trip grouped (interleaved, headersAtTop) json5-rowset text OK');

console.log('\nAll checks passed.');
