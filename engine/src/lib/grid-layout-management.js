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

export { gridLayoutInspectCode };
