function parseShaderProperties(raw) {
  if (raw === undefined || raw === null) return undefined;
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid shader properties JSON: ${error.message}`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Shader properties must be a JSON object keyed by property-definition ID');
  return value;
}

function shaderFactsCode() {
  return `const __shaderFacts = (shader) => ({ id: shader.id, name: shader.name, type: shader.type, imported: !!shader.imported, propertyDefinitions: shader.propertyDefinitions || null });`;
}

function shaderListCode() {
  return `(async () => {${shaderFactsCode()} if (typeof figma.listAvailableShaders !== 'function') throw new Error('Shaders are unavailable in this Figma editor'); return (await figma.listAvailableShaders()).map(__shaderFacts); })()`;
}

function shaderImportCode({ shaderId }) {
  return `(async () => {${shaderFactsCode()} if (typeof figma.importShaderById !== 'function') throw new Error('Shaders are unavailable in this Figma editor'); return __shaderFacts(await figma.importShaderById(${JSON.stringify(shaderId)})); })()`;
}

function shaderApplyCode({ nodeId, shaderId, field, properties, replace = false }) {
  const normalizedField = String(field || '').toLowerCase();
  if (!['fill', 'stroke', 'effect'].includes(normalizedField)) throw new Error('Shader field must be fill, stroke, or effect');
  const parsedProperties = parseShaderProperties(properties);
  return `(async () => {${shaderFactsCode()}
if (figma.editorType !== 'figma') throw new Error('Shaders are only available in Figma Design');
if (typeof figma.listAvailableShaders !== 'function') throw new Error('Shaders are unavailable in this Figma editor');
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) throw new Error('Node not found: ${String(nodeId)}');
const shader = (await figma.listAvailableShaders()).find(s => s.id === ${JSON.stringify(shaderId)});
if (!shader) throw new Error('Shader not available: ${String(shaderId)}');
if (!shader.imported) throw new Error('Shader is not imported; run shader import first: ' + shader.id);
if (${JSON.stringify(normalizedField)} === 'effect' && shader.type !== 'effect') throw new Error('Fill shader cannot be applied as an effect');
if (${JSON.stringify(normalizedField)} !== 'effect' && shader.type !== 'fill') throw new Error('Effect shader cannot be applied as a paint');
const value = { type: 'SHADER', id: shader.id${parsedProperties === undefined ? '' : `, properties: ${JSON.stringify(parsedProperties)}`}${normalizedField === 'effect' ? ', visible: true' : ''} };
let count;
if (${JSON.stringify(normalizedField)} === 'effect') {
  if (!('effects' in node)) throw new Error(node.type + ' does not support effects');
  node.effects = ${replace ? '[value]' : '[...(node.effects || []), value]'}; count = node.effects.length;
} else if (${JSON.stringify(normalizedField)} === 'fill') {
  if (!('fills' in node) || node.fills === figma.mixed) throw new Error(node.type + ' does not support uniform fills');
  node.fills = ${replace ? '[value]' : '[...(node.fills || []), value]'}; count = node.fills.length;
} else {
  if (!('strokes' in node)) throw new Error(node.type + ' does not support strokes');
  node.strokes = ${replace ? '[value]' : '[...(node.strokes || []), value]'}; count = node.strokes.length;
}
return { node: { id: node.id, name: node.name, type: node.type }, shader: __shaderFacts(shader), field: ${JSON.stringify(normalizedField)}, count };
})()`;
}

export { parseShaderProperties, shaderApplyCode, shaderImportCode, shaderListCode };
