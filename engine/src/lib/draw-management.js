const WIDTH_PROFILES = Object.freeze(['UNIFORM', 'WEDGE', 'TAPER', 'QUARTER_TAPER', 'EYE', 'MIRRORED_TAPER']);

function parseJson(raw, label) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid ${label} JSON: ${error.message}`); }
}

function drawNodeCode(nodeId, body) {
  return `(async () => { if (figma.editorType !== 'figma') throw new Error('Figma Draw APIs are only available in Figma Design'); const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)}); if (!node) throw new Error('Node not found: ${String(nodeId)}'); ${body} })()`;
}

function drawInspectCode({ nodeId }) {
  return drawNodeCode(nodeId, `return { id: node.id, name: node.name, type: node.type, ...(node.type === 'TEXT_PATH' ? { textPathStartData: node.textPathStartData, characters: node.characters } : {}), ...('transformModifiers' in node ? { transformModifiers: node.transformModifiers } : {}), ...('complexStrokeProperties' in node ? { complexStrokeProperties: node.complexStrokeProperties, variableWidthStrokeProperties: node.variableWidthStrokeProperties } : {}), ...('fills' in node && node.fills !== figma.mixed ? { patternFills: node.fills.filter(p => p.type === 'PATTERN') } : {}), ...('strokes' in node ? { patternStrokes: node.strokes.filter(p => p.type === 'PATTERN') } : {}) };`);
}

function drawTextPathCode({ nodeId, segment = 0, position = 0, text, fontFamily = 'Inter', fontStyle = 'Regular' }) {
  const parsedSegment = Number(segment), parsedPosition = Number(position);
  if (!Number.isInteger(parsedSegment) || parsedSegment < 0) throw new Error('--segment must be a zero-based integer');
  if (!Number.isFinite(parsedPosition) || parsedPosition < 0 || parsedPosition > 1) throw new Error('--position must be between 0 and 1');
  return drawNodeCode(nodeId, `if (!['VECTOR','RECTANGLE','ELLIPSE','POLYGON','STAR','LINE'].includes(node.type)) throw new Error(node.type + ' cannot become text on a path'); await figma.loadFontAsync({ family: ${JSON.stringify(fontFamily)}, style: ${JSON.stringify(fontStyle)} }); const textPath = figma.createTextPath(node, ${parsedSegment}, ${parsedPosition}); textPath.fontName = { family: ${JSON.stringify(fontFamily)}, style: ${JSON.stringify(fontStyle)} }; textPath.characters = ${JSON.stringify(String(text))}; return { id: textPath.id, name: textPath.name, type: textPath.type, characters: textPath.characters, textPathStartData: textPath.textPathStartData };`);
}

function parseTransformModifiers(raw) {
  const modifiers = parseJson(raw, 'transform modifiers');
  if (!Array.isArray(modifiers) || !modifiers.length) throw new Error('Transform modifiers must be a non-empty JSON array');
  for (const modifier of modifiers) {
    if (!modifier || modifier.type !== 'REPEAT' || !['LINEAR', 'RADIAL'].includes(modifier.repeatType)) throw new Error('Only REPEAT LINEAR/RADIAL transform modifiers are supported by Figma');
    if (!Number.isInteger(modifier.count) || modifier.count < 1) throw new Error('Repeat count must be an integer >= 1');
    if (!['RELATIVE', 'PIXELS'].includes(modifier.unitType) || !Number.isFinite(modifier.offset)) throw new Error('Repeat modifiers require unitType RELATIVE|PIXELS and numeric offset');
    if (modifier.repeatType === 'LINEAR' && !['HORIZONTAL', 'VERTICAL'].includes(modifier.axis)) throw new Error('Linear repeats require axis HORIZONTAL|VERTICAL');
  }
  return modifiers;
}

function drawTransformGroupCode({ nodeIds, parentId = null, index = null, modifiers }) {
  const ids = String(nodeIds).split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error('Provide comma-separated node IDs');
  const parsedModifiers = parseTransformModifiers(modifiers);
  const parsedIndex = index === null || index === undefined ? null : Number(index);
  if (parsedIndex !== null && (!Number.isInteger(parsedIndex) || parsedIndex < 0)) throw new Error('--index must be a non-negative integer');
  return `(async () => { if (figma.editorType !== 'figma') throw new Error('Figma Draw APIs are only available in Figma Design'); const nodes = []; for (const id of ${JSON.stringify(ids)}) { const node = await figma.getNodeByIdAsync(id); if (!node || !('x' in node)) throw new Error('Scene node not found: ' + id); nodes.push(node); } const parent = ${parentId ? `await figma.getNodeByIdAsync(${JSON.stringify(parentId)})` : 'figma.currentPage'}; if (!parent || !('children' in parent)) throw new Error('Parent cannot contain children'); const insertionIndex = ${parsedIndex === null ? 'parent.children.length' : parsedIndex}; const group = figma.transformGroup(nodes, parent, insertionIndex, ${JSON.stringify(parsedModifiers)}); return { id: group.id, name: group.name, type: group.type, childIds: group.children.map(n => n.id), transformModifiers: group.transformModifiers }; })()`;
}

function parseComplexStroke(raw) {
  const value = parseJson(raw, 'complex stroke');
  if (!value || !['BRUSH', 'DYNAMIC', 'BASIC'].includes(value.type)) throw new Error('Complex stroke type must be BRUSH, DYNAMIC, or BASIC');
  if (value.type === 'BRUSH' && !['STRETCH', 'SCATTER'].includes(value.brushType)) throw new Error('Brush type must be STRETCH or SCATTER');
  if (value.type === 'BRUSH' && value.brushName === 'CUSTOM') throw new Error('The Plugin API cannot set custom brushes');
  return value;
}

function drawBrushCode({ nodeId, properties }) {
  const parsed = parseComplexStroke(properties);
  return drawNodeCode(nodeId, `if (!('complexStrokeProperties' in node)) throw new Error(node.type + ' does not support complex strokes'); const before = node.complexStrokeProperties; ${parsed.type === 'BRUSH' ? `await figma.loadBrushesAsync(${JSON.stringify(parsed.brushType)});` : ''} node.complexStrokeProperties = ${JSON.stringify(parsed)}; return { id: node.id, name: node.name, before, after: node.complexStrokeProperties };`);
}

function parseWidthPoints(raw) {
  const points = parseJson(raw, 'width points');
  if (!Array.isArray(points) || points.some((point) => !point || !Number.isFinite(point.position) || point.position < 0 || point.position > 1 || !Number.isFinite(point.width) || point.width < 0)) throw new Error('Width points must be [{"position":0..1,"width":number>=0}]');
  return points;
}

function drawStrokeProfileCode({ nodeId, preset, points, clear = false }) {
  if ([preset !== undefined, points !== undefined, clear].filter(Boolean).length !== 1) throw new Error('Use exactly one of --preset, --points, or --clear');
  let value = null;
  if (preset !== undefined) {
    const normalized = String(preset).toUpperCase();
    if (!WIDTH_PROFILES.includes(normalized)) throw new Error(`Preset must be one of: ${WIDTH_PROFILES.join(', ')}`);
    value = { widthProfile: normalized };
  } else if (points !== undefined) value = { widthProfile: 'CUSTOM', variableWidthPoints: parseWidthPoints(points) };
  return drawNodeCode(nodeId, `if (!('variableWidthStrokeProperties' in node)) throw new Error(node.type + ' does not support variable-width strokes'); const before = node.variableWidthStrokeProperties; node.variableWidthStrokeProperties = ${JSON.stringify(value)}; return { id: node.id, name: node.name, before, after: node.variableWidthStrokeProperties };`);
}

function drawPatternCode({ nodeId, sourceNodeId, field, tileType = 'RECTANGULAR', scalingFactor = 1, spacingX = 0, spacingY = 0, alignment = 'CENTER', replace = false }) {
  const normalizedField = String(field).toLowerCase();
  if (!['fill', 'stroke'].includes(normalizedField)) throw new Error('--field must be fill or stroke');
  const normalizedTile = String(tileType).toUpperCase();
  if (!['RECTANGULAR', 'HORIZONTAL_HEXAGONAL', 'VERTICAL_HEXAGONAL'].includes(normalizedTile)) throw new Error('Unknown pattern tile type');
  const normalizedAlignment = String(alignment).toUpperCase();
  if (!['START', 'CENTER', 'END'].includes(normalizedAlignment)) throw new Error('Pattern alignment must be start, center, or end');
  for (const [label, value] of [['--scale', scalingFactor], ['--spacing-x', spacingX], ['--spacing-y', spacingY]]) if (!Number.isFinite(Number(value))) throw new Error(`${label} must be numeric`);
  const method = normalizedField === 'fill' ? 'setFillsAsync' : 'setStrokesAsync';
  const current = normalizedField === 'fill' ? 'fills' : 'strokes';
  const paint = { type: 'PATTERN', sourceNodeId: String(sourceNodeId), tileType: normalizedTile, scalingFactor: Number(scalingFactor), spacing: { x: Number(spacingX), y: Number(spacingY) }, horizontalAlignment: normalizedAlignment };
  return drawNodeCode(nodeId, `const source = await figma.getNodeByIdAsync(${JSON.stringify(sourceNodeId)}); if (!source || !('x' in source)) throw new Error('Pattern source scene node not found: ${String(sourceNodeId)}'); if (typeof node.${method} !== 'function') throw new Error(node.type + ' does not support async pattern ${normalizedField}s'); const before = node.${current} === figma.mixed ? [] : node.${current}; const paint = ${JSON.stringify(paint)}; await node.${method}(${replace ? '[paint]' : '[...before, paint]'}); return { id: node.id, name: node.name, field: ${JSON.stringify(normalizedField)}, pattern: paint, count: node.${current}.length };`);
}

export {
  WIDTH_PROFILES, drawBrushCode, drawInspectCode, drawPatternCode,
  drawStrokeProfileCode, drawTextPathCode, drawTransformGroupCode,
  parseComplexStroke, parseTransformModifiers, parseWidthPoints,
};
