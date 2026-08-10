const SIDES = Object.freeze(['TOP', 'RIGHT', 'BOTTOM', 'LEFT']);

function parseMeasurementEndpoint(value) {
  const match = String(value || '').trim().match(/^(.+):(top|right|bottom|left)$/i);
  if (!match) throw new Error('Measurement endpoint must be <nodeId>:top|right|bottom|left');
  return { nodeId: match[1], side: match[2].toUpperCase() };
}

function parseMeasurementOffset({ offset, relative } = {}) {
  if (offset !== undefined && relative !== undefined) throw new Error('Use either --offset or --relative');
  if (offset !== undefined) {
    const fixed = Number(offset);
    if (!Number.isFinite(fixed)) throw new Error('--offset must be a finite number');
    return { type: 'OUTER', fixed };
  }
  if (relative !== undefined) {
    const value = Number(relative);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('--relative must be between 0 and 1');
    return { type: 'INNER', relative: value };
  }
  return undefined;
}

function factsCode() {
  return `const __measurementFacts = (m) => ({ id: m.id, start: { node: { id: m.start.node.id, name: m.start.node.name, type: m.start.node.type }, side: m.start.side }, end: { node: { id: m.end.node.id, name: m.end.node.name, type: m.end.node.type }, side: m.end.side }, offset: m.offset, freeText: m.freeText || '' });`;
}

function measurementListCode({ nodeId = null } = {}) {
  return `(async () => {${factsCode()}
${nodeId ? `const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)}); if (!node || !('x' in node)) throw new Error('Scene node not found: ${String(nodeId)}');` : ''}
const measurements = ${nodeId ? 'figma.currentPage.getMeasurementsForNode(node)' : 'figma.currentPage.getMeasurements()'};
return measurements.map(__measurementFacts);
})()`;
}

function measurementAddCode({ from, to, offset, relative, text = '' }) {
  const start = parseMeasurementEndpoint(from);
  const end = parseMeasurementEndpoint(to);
  const parsedOffset = parseMeasurementOffset({ offset, relative });
  return `(async () => {${factsCode()}
if (figma.editorType !== 'dev') throw new Error('Measurements can only be changed in Figma Dev Mode');
const startNode = await figma.getNodeByIdAsync(${JSON.stringify(start.nodeId)});
const endNode = await figma.getNodeByIdAsync(${JSON.stringify(end.nodeId)});
if (!startNode || !('x' in startNode)) throw new Error('Start scene node not found: ${start.nodeId}');
if (!endNode || !('x' in endNode)) throw new Error('End scene node not found: ${end.nodeId}');
const measurement = figma.currentPage.addMeasurement({ node: startNode, side: ${JSON.stringify(start.side)} }, { node: endNode, side: ${JSON.stringify(end.side)} }, ${JSON.stringify({ ...(parsedOffset ? { offset: parsedOffset } : {}), ...(text ? { freeText: String(text) } : {}) })});
return __measurementFacts(measurement);
})()`;
}

function measurementEditCode({ id, offset, relative, text }) {
  const parsedOffset = parseMeasurementOffset({ offset, relative });
  if (!parsedOffset && text === undefined) throw new Error('Provide --offset, --relative, or --text');
  return `(async () => {${factsCode()}
if (figma.editorType !== 'dev') throw new Error('Measurements can only be changed in Figma Dev Mode');
const measurement = figma.currentPage.editMeasurement(${JSON.stringify(id)}, ${JSON.stringify({ ...(parsedOffset ? { offset: parsedOffset } : {}), ...(text !== undefined ? { freeText: String(text) } : {}) })});
return __measurementFacts(measurement);
})()`;
}

function measurementDeleteCode({ id }) {
  return `(async () => {
if (figma.editorType !== 'dev') throw new Error('Measurements can only be changed in Figma Dev Mode');
const before = figma.currentPage.getMeasurements().find(m => m.id === ${JSON.stringify(id)});
if (!before) throw new Error('Measurement not found: ${String(id)}');
figma.currentPage.deleteMeasurement(${JSON.stringify(id)});
return { id: ${JSON.stringify(id)}, deleted: true };
})()`;
}

export {
  SIDES, measurementAddCode, measurementDeleteCode, measurementEditCode,
  measurementListCode, parseMeasurementEndpoint, parseMeasurementOffset,
};
