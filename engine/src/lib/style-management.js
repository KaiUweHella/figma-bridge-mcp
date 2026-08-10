const STYLE_TYPES = Object.freeze(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const STYLE_FIELDS = Object.freeze({
  PAINT: ['paints'],
  TEXT: [
    'fontName', 'fontSize', 'textDecoration', 'textCase', 'letterSpacing',
    'lineHeight', 'leadingTrim', 'paragraphIndent', 'paragraphSpacing',
    'listSpacing', 'hangingPunctuation', 'hangingList',
  ],
  EFFECT: ['effects'],
  GRID: ['layoutGrids'],
});

function parseStyleType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!STYLE_TYPES.includes(type)) {
    throw new Error(`Style type must be one of: ${STYLE_TYPES.join(', ')}`);
  }
  return type;
}

function parseStyleProperties(raw, type) {
  if (raw === undefined) return {};
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid --properties JSON: ${error.message}`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('--properties must be a JSON object');
  }
  const allowed = new Set(STYLE_FIELDS[parseStyleType(type)]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unsupported ${type} style properties: ${unknown.join(', ')}`);
  return value;
}

function styleHelpersCode() {
  return `
const __styleLists = async () => ({
  PAINT: await figma.getLocalPaintStylesAsync(),
  TEXT: await figma.getLocalTextStylesAsync(),
  EFFECT: await figma.getLocalEffectStylesAsync(),
  GRID: await figma.getLocalGridStylesAsync(),
});
const __resolveStyle = async (query, type) => {
  const direct = await figma.getStyleByIdAsync(query);
  if (direct && (!type || direct.type === type)) return direct;
  const lists = await __styleLists();
  const pool = type ? lists[type] : Object.values(lists).flat();
  const exact = pool.filter(s => s.name === query);
  const matches = exact.length ? exact : pool.filter(s => s.name.toLowerCase().includes(String(query).toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous style "' + query + '": ' + matches.map(s => s.type + ':' + s.name).join(', '));
  if (!matches.length) throw new Error('Style not found: ' + query);
  return matches[0];
};
const __styleFacts = (s) => {
  const out = { id: s.id, key: s.key || null, name: s.name, description: s.description || '', type: s.type, remote: !!s.remote };
  if (s.type === 'PAINT') out.paints = s.paints;
  if (s.type === 'TEXT') for (const key of ${JSON.stringify(STYLE_FIELDS.TEXT)}) out[key] = s[key];
  if (s.type === 'EFFECT') out.effects = s.effects;
  if (s.type === 'GRID') out.layoutGrids = s.layoutGrids;
  if (s.boundVariables) out.boundVariables = s.boundVariables;
  return out;
};`;
}

function styleListCode({ type = null } = {}) {
  const normalized = type ? parseStyleType(type) : null;
  return `(async () => {${styleHelpersCode()}
const lists = await __styleLists();
const styles = ${normalized ? `lists[${JSON.stringify(normalized)}]` : 'Object.values(lists).flat()'};
return styles.map(__styleFacts).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
})()`;
}

function styleShowCode({ style }) {
  return `(async () => {${styleHelpersCode()}
return __styleFacts(await __resolveStyle(${JSON.stringify(style)}, null));
})()`;
}

function styleCreateCode({ type, name, description = '', properties = {} }) {
  const normalized = parseStyleType(type);
  const props = parseStyleProperties(properties, normalized);
  const factory = { PAINT: 'createPaintStyle', TEXT: 'createTextStyle', EFFECT: 'createEffectStyle', GRID: 'createGridStyle' }[normalized];
  return `(async () => {${styleHelpersCode()}
const style = figma.${factory}();
style.name = ${JSON.stringify(String(name).trim())};
style.description = ${JSON.stringify(String(description || ''))};
const props = ${JSON.stringify(props)};
if (style.type === 'TEXT' && props.fontName) await figma.loadFontAsync(props.fontName);
for (const [key, value] of Object.entries(props)) style[key] = value;
return __styleFacts(style);
})()`;
}

function styleUpdateCode({ style, name, description, properties, type }) {
  const normalized = type ? parseStyleType(type) : null;
  const props = properties === undefined ? null : parseStyleProperties(properties, normalized);
  return `(async () => {${styleHelpersCode()}
const target = await __resolveStyle(${JSON.stringify(style)}, ${JSON.stringify(normalized)});
if (target.remote) throw new Error('Remote styles cannot be updated');
${name === undefined ? '' : `target.name = ${JSON.stringify(String(name).trim())};`}
${description === undefined ? '' : `target.description = ${JSON.stringify(String(description))};`}
const props = ${JSON.stringify(props)};
if (props) {
  if (target.type === 'TEXT' && props.fontName) await figma.loadFontAsync(props.fontName);
  for (const [key, value] of Object.entries(props)) target[key] = value;
}
return __styleFacts(target);
})()`;
}

function styleApplyCode({ style, nodeIds, field }) {
  const normalizedField = String(field || '').toLowerCase();
  const fields = ['fill', 'stroke', 'text', 'effect', 'grid'];
  if (!fields.includes(normalizedField)) throw new Error(`Style field must be one of: ${fields.join(', ')}`);
  const ids = String(nodeIds).split(/[\s,]+/).filter(Boolean);
  if (!ids.length) throw new Error('At least one node ID is required');
  const expected = { fill: 'PAINT', stroke: 'PAINT', text: 'TEXT', effect: 'EFFECT', grid: 'GRID' }[normalizedField];
  const method = { fill: 'setFillStyleIdAsync', stroke: 'setStrokeStyleIdAsync', text: 'setTextStyleIdAsync', effect: 'setEffectStyleIdAsync', grid: 'setGridStyleIdAsync' }[normalizedField];
  return `(async () => {${styleHelpersCode()}
const style = await __resolveStyle(${JSON.stringify(style)}, ${JSON.stringify(expected)});
const ids = ${JSON.stringify(ids)};
const applied = [];
for (const id of ids) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error('Node not found: ' + id);
  if (typeof node.${method} !== 'function') throw new Error(node.type + ' does not support ${normalizedField} styles: ' + id);
  await node.${method}(style.id);
  applied.push({ id: node.id, name: node.name, type: node.type });
}
return { style: __styleFacts(style), field: ${JSON.stringify(normalizedField)}, applied };
})()`;
}

function styleConsumersCode({ style }) {
  return `(async () => {${styleHelpersCode()}
const target = await __resolveStyle(${JSON.stringify(style)}, null);
const consumers = await target.getStyleConsumersAsync();
return { style: __styleFacts(target), consumers: consumers.map(c => ({ node: { id: c.node.id, name: c.node.name, type: c.node.type }, fields: c.fields })) };
})()`;
}

function stylePublishStatusCode({ style }) {
  return `(async () => {${styleHelpersCode()}
const target = await __resolveStyle(${JSON.stringify(style)}, null);
return { style: __styleFacts(target), publishStatus: await target.getPublishStatusAsync() };
})()`;
}

function styleDeleteCode({ style }) {
  return `(async () => {${styleHelpersCode()}
const target = await __resolveStyle(${JSON.stringify(style)}, null);
if (target.remote) throw new Error('Remote styles cannot be deleted');
const facts = __styleFacts(target); target.remove(); return facts;
})()`;
}

export {
  STYLE_FIELDS, STYLE_TYPES, parseStyleProperties, parseStyleType,
  styleApplyCode, styleConsumersCode, styleCreateCode, styleDeleteCode,
  styleListCode, stylePublishStatusCode, styleShowCode, styleUpdateCode,
};
