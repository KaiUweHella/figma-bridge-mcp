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

export {
  STYLE_FIELDS, STYLE_TYPES, parseStyleProperties, parseStyleType,
};
