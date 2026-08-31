function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be an integer >= 1`);
  return number;
}

function parseTrackSizes(raw, label) {
  if (raw === undefined) return undefined;
  let values;
  try { values = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid ${label} JSON: ${error.message}`); }
  if (!Array.isArray(values)) throw new Error(`${label} must be a JSON array`);
  for (const value of values) {
    if (!value || !['FLEX', 'FIXED', 'HUG'].includes(String(value.type).toUpperCase())) throw new Error(`${label} tracks require type FLEX, FIXED, or HUG`);
    value.type = String(value.type).toUpperCase();
    if (value.value !== undefined && (!Number.isFinite(Number(value.value)) || Number(value.value) < 0)) throw new Error(`${label} track values must be non-negative numbers`);
    if (value.value !== undefined) value.value = Number(value.value);
  }
  return values;
}

function gridFactsCode() {
  return `const __gridFacts = (n) => ({ id: n.id, name: n.name, type: n.type, layoutMode: n.layoutMode, rows: n.gridRowCount, columns: n.gridColumnCount, rowGap: n.gridRowGap, columnGap: n.gridColumnGap, rowSizes: Array.from(n.gridRowSizes || [], t => ({ type: t.type, ...(t.value === undefined ? {} : { value: t.value }) })), columnSizes: Array.from(n.gridColumnSizes || [], t => ({ type: t.type, ...(t.value === undefined ? {} : { value: t.value }) })), autoTracks: n.gridAutoTracks, itemsPositioning: n.gridItemsPositioning });`;
}

function gridNodeCode(nodeId, body) {
  return `(async () => {${gridFactsCode()}
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) throw new Error('Node not found: ${String(nodeId)}');
if (!('layoutMode' in node)) throw new Error(node.type + ' does not support Auto Layout Grid');
${body}
})()`;
}

function gridLayoutInspectCode({ nodeId }) {
  return gridNodeCode(nodeId, `if (node.layoutMode !== 'GRID') throw new Error('Node is not an Auto Layout Grid container'); return __gridFacts(node);`);
}

function gridLayoutSetCode({ nodeId, rows, columns, rowGap, columnGap, rowSizes, columnSizes }) {
  const parsedRows = rows === undefined ? undefined : parsePositiveInteger(rows, '--rows');
  const parsedColumns = columns === undefined ? undefined : parsePositiveInteger(columns, '--columns');
  const parsedRowGap = rowGap === undefined ? undefined : Number(rowGap);
  const parsedColumnGap = columnGap === undefined ? undefined : Number(columnGap);
  if (parsedRowGap !== undefined && (!Number.isFinite(parsedRowGap) || parsedRowGap < 0)) throw new Error('--row-gap must be non-negative');
  if (parsedColumnGap !== undefined && (!Number.isFinite(parsedColumnGap) || parsedColumnGap < 0)) throw new Error('--column-gap must be non-negative');
  const parsedRowSizes = parseTrackSizes(rowSizes, '--row-sizes');
  const parsedColumnSizes = parseTrackSizes(columnSizes, '--column-sizes');
  if ([parsedRows, parsedColumns, parsedRowGap, parsedColumnGap, parsedRowSizes, parsedColumnSizes].every((value) => value === undefined)) throw new Error('Provide grid dimensions, gaps, or track sizes');
  if (parsedRowSizes && parsedRows !== undefined && parsedRowSizes.length !== parsedRows) throw new Error('--row-sizes length must equal --rows');
  if (parsedColumnSizes && parsedColumns !== undefined && parsedColumnSizes.length !== parsedColumns) throw new Error('--column-sizes length must equal --columns');
  return gridNodeCode(nodeId, `const before = node.layoutMode === 'GRID' ? __gridFacts(node) : { layoutMode: node.layoutMode };
if (node.layoutMode !== 'GRID') node.layoutMode = 'GRID';
${parsedRows === undefined ? '' : `node.gridRowCount = ${parsedRows};`}
${parsedColumns === undefined ? '' : `node.gridColumnCount = ${parsedColumns};`}
${parsedRowGap === undefined ? '' : `node.gridRowGap = ${parsedRowGap};`}
${parsedColumnGap === undefined ? '' : `node.gridColumnGap = ${parsedColumnGap};`}
${parsedRowSizes === undefined ? '' : `if (node.gridRowSizes.length !== ${parsedRowSizes.length}) node.gridRowCount = ${parsedRowSizes.length}; ${parsedRowSizes.map((track, index) => `node.gridRowSizes[${index}].type = ${JSON.stringify(track.type)};${track.value === undefined ? '' : ` node.gridRowSizes[${index}].value = ${track.value};`}`).join(' ')}`}
${parsedColumnSizes === undefined ? '' : `if (node.gridColumnSizes.length !== ${parsedColumnSizes.length}) node.gridColumnCount = ${parsedColumnSizes.length}; ${parsedColumnSizes.map((track, index) => `node.gridColumnSizes[${index}].type = ${JSON.stringify(track.type)};${track.value === undefined ? '' : ` node.gridColumnSizes[${index}].value = ${track.value};`}`).join(' ')}`}
return { before, after: __gridFacts(node) };`);
}

export {
  gridLayoutInspectCode, gridLayoutSetCode, parseTrackSizes,
};
