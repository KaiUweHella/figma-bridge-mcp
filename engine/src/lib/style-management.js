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

function styleDeleteCode({ style }) {
  return `(async () => {${styleHelpersCode()}
const target = await __resolveStyle(${JSON.stringify(style)}, null);
if (target.remote) throw new Error('Remote styles cannot be deleted');
const facts = __styleFacts(target); target.remove(); return facts;
})()`;
}

const TEXT_VARIABLE_FIELDS = Object.freeze([
  'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
  'lineHeight', 'paragraphSpacing', 'paragraphIndent',
]);

function styleBindVariableCode({ style, field, variable = null }) {
  const normalizedField = String(field || '').trim();
  if (!TEXT_VARIABLE_FIELDS.includes(normalizedField)) {
    throw new Error(`Text style variable field must be one of: ${TEXT_VARIABLE_FIELDS.join(', ')}`);
  }
  return `(async () => {${styleHelpersCode()}
const target = await __resolveStyle(${JSON.stringify(style)}, 'TEXT');
if (target.remote) throw new Error('Remote text styles cannot be updated');
let variable = null;
if (${JSON.stringify(variable)} !== null) {
  const vars = await figma.variables.getLocalVariablesAsync();
  const query = ${JSON.stringify(variable)};
  variable = await figma.variables.getVariableByIdAsync(query);
  if (!variable) {
    const exact = vars.filter(v => v.name === query);
    const matches = exact.length ? exact : vars.filter(v => v.name.toLowerCase().includes(String(query).toLowerCase()));
    if (matches.length > 1) throw new Error('Ambiguous variable "' + query + '": ' + matches.map(v => v.name).join(', '));
    if (!matches.length) throw new Error('Variable not found: ' + query);
    variable = matches[0];
  }
}
target.setBoundVariable(${JSON.stringify(normalizedField)}, variable);
return { style: __styleFacts(target), field: ${JSON.stringify(normalizedField)}, variable: variable ? { id: variable.id, name: variable.name, resolvedType: variable.resolvedType } : null };
})()`;
}

export {
  STYLE_FIELDS, STYLE_TYPES, TEXT_VARIABLE_FIELDS, parseStyleProperties, parseStyleType,
  styleBindVariableCode,
  styleDeleteCode, styleUpdateCode,
};
