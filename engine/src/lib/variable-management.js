import { VARIABLE_SCOPES_BY_TYPE } from './variable-scope-policy.js';

const VARIABLE_SCOPES = Object.freeze([
  'ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP',
  'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR',
  'STROKE_FLOAT', 'EFFECT_FLOAT', 'EFFECT_COLOR', 'OPACITY', 'FONT_FAMILY',
  'FONT_STYLE', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING',
  'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT',
]);

const VARIABLE_TYPES = Object.freeze(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const MAX_VARIABLE_DESCRIPTION_CODE_UNITS = 65_536;
const EASING_TYPES = Object.freeze([
  'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK',
  'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE',
  'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD',
]);

function parseVariableType(value) {
  const type = String(value).trim().toUpperCase();
  if (!VARIABLE_TYPES.includes(type)) throw new Error(`Type must be one of: ${VARIABLE_TYPES.join(', ')}`);
  return type;
}

function normalizeVariableDescription(value) {
  if (typeof value !== 'string') throw new Error('description must be text');
  if (value.length > MAX_VARIABLE_DESCRIPTION_CODE_UNITS) {
    throw new Error(`description must be at most ${MAX_VARIABLE_DESCRIPTION_CODE_UNITS} code units`);
  }
  return value;
}

function normalizeVariableHidden(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || !/^(true|false)$/i.test(value)) {
    throw new Error('hidden must be true or false');
  }
  return value.toLowerCase() === 'true';
}

function normalizeVariableScopes(value, resolvedType = null) {
  const parts = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(',') : null;
  if (!parts) throw new Error('scopes must be a comma-separated list or array');
  const scopes = parts.map((scope) => String(scope).trim().toUpperCase()).filter(Boolean);
  const invalid = scopes.filter((scope) => !VARIABLE_SCOPES.includes(scope));
  if (invalid.length) throw new Error(`unknown scopes: ${invalid.join(', ')}`);
  if (new Set(scopes).size !== scopes.length) throw new Error('scopes must not contain duplicates');
  if (scopes.includes('ALL_SCOPES') && scopes.length !== 1) {
    throw new Error('ALL_SCOPES must be the only scope');
  }
  if (resolvedType !== null) {
    const type = parseVariableType(resolvedType);
    const allowed = VARIABLE_SCOPES_BY_TYPE[type] || ['ALL_SCOPES'];
    const incompatible = scopes.filter((scope) => !allowed.includes(scope));
    if (incompatible.length) {
      throw new Error(`${incompatible.join(', ')} scopes are incompatible with ${type}`);
    }
  }
  return scopes;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function finiteUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizeVariableValue(value, typeValue) {
  const type = parseVariableType(typeValue);
  if (type === 'STRING') {
    if (typeof value !== 'string') throw new Error('STRING value must be text');
    return value;
  }
  if (type === 'BOOLEAN') return parseBoolean(value, 'BOOLEAN value');
  if (type === 'FLOAT' || type === 'TIMING') {
    const number = typeof value === 'number' ? value : Number(String(value));
    if (!Number.isFinite(number)) throw new Error(`${type} value must be a finite number`);
    if (type === 'TIMING' && number < 0) throw new Error('TIMING value must be zero or greater');
    return number;
  }
  if (type === 'COLOR') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const rgb = exactKeys(value, ['r', 'g', 'b']);
      const rgba = exactKeys(value, ['r', 'g', 'b', 'a']);
      if ((rgb || rgba) && finiteUnit(value.r) && finiteUnit(value.g)
        && finiteUnit(value.b) && (!rgba || finiteUnit(value.a))) return { ...value };
      throw new Error('COLOR value must contain unit r, g, b and optional a channels');
    }
    const match = String(value).match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (!match) throw new Error('COLOR value must be #RGB, #RGBA, #RRGGBB, or #RRGGBBAA');
    let hex = match[1];
    if (hex.length <= 4) hex = [...hex].map((character) => character + character).join('');
    const color = {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
    if (hex.length === 8) color.a = parseInt(hex.slice(6, 8), 16) / 255;
    return color;
  }
  let easing;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    easing = { ...value };
  } else {
    const raw = String(value);
    try { easing = JSON.parse(raw); }
    catch {
      const named = raw.trim().toUpperCase().replace(/[ -]+/g, '_');
      easing = { type: named };
    }
  }
  if (!easing || typeof easing !== 'object' || Array.isArray(easing)) throw new Error('EASING value must be a named easing or JSON object');
  easing.type = String(easing.type || '').toUpperCase().replace(/[ -]+/g, '_');
  if (!EASING_TYPES.includes(easing.type)) throw new Error(`Unknown EASING type: ${easing.type || '(missing)'}`);
  const allowed = new Set(['type', 'easingFunctionCubicBezier', 'easingFunctionSpring']);
  if (!Object.keys(easing).every((key) => allowed.has(key))) {
    throw new Error('EASING value contains unsupported fields');
  }
  if (easing.easingFunctionCubicBezier !== undefined) {
    const bezier = easing.easingFunctionCubicBezier;
    if (!exactKeys(bezier, ['x1', 'y1', 'x2', 'y2'])
      || !finiteUnit(bezier.x1) || !finiteUnit(bezier.x2)
      || typeof bezier.y1 !== 'number' || !Number.isFinite(bezier.y1)
      || typeof bezier.y2 !== 'number' || !Number.isFinite(bezier.y2)) {
      throw new Error('EASING cubic bezier must contain finite x1, y1, x2, y2 values');
    }
  }
  if (easing.easingFunctionSpring !== undefined) {
    const spring = easing.easingFunctionSpring;
    if (!exactKeys(spring, ['bounce']) || !finiteUnit(spring.bounce)) {
      throw new Error('EASING spring bounce must be between zero and one');
    }
  }
  if (easing.easingFunctionCubicBezier !== undefined
    && easing.easingFunctionSpring !== undefined) {
    throw new Error('EASING value cannot contain both cubic bezier and spring functions');
  }
  return easing;
}

function parseVariableLiteral(value, typeValue) {
  return normalizeVariableValue(String(value), typeValue);
}

function parseBoolean(value, label = 'value') {
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function variableHelpersCode() {
  return `
const __collections = await figma.variables.getLocalVariableCollectionsAsync();
const __allVars = await figma.variables.getLocalVariablesAsync();
const __resolveCollection = async (query) => {
  const direct = await figma.variables.getVariableCollectionByIdAsync(query);
  if (direct) return direct;
  const exact = __collections.filter(c => c.name === query);
  const matches = exact.length ? exact : __collections.filter(c => c.name.toLowerCase().includes(String(query).toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous collection "' + query + '": ' + matches.map(c => c.name).join(', '));
  if (!matches.length) throw new Error('Collection not found: ' + query);
  return matches[0];
};
const __resolveVariable = async (query, collectionHint) => {
  const direct = await figma.variables.getVariableByIdAsync(query);
  if (direct) {
    if (collectionHint) {
      const col = await __resolveCollection(collectionHint);
      if (direct.variableCollectionId !== col.id) throw new Error('Variable is not in collection: ' + collectionHint);
    }
    return direct;
  }
  let pool = __allVars;
  if (collectionHint) {
    const col = await __resolveCollection(collectionHint);
    pool = pool.filter(v => v.variableCollectionId === col.id);
  }
  const exact = pool.filter(v => v.name === query);
  const tail = pool.filter(v => v.name.endsWith('/' + query));
  const partial = pool.filter(v => v.name.toLowerCase().includes(String(query).toLowerCase()));
  const matches = exact.length ? exact : (tail.length ? tail : partial);
  if (matches.length > 1) throw new Error('Ambiguous variable "' + query + '": ' + matches.map(v => v.name).join(', '));
  if (!matches.length) throw new Error('Variable not found: ' + query);
  return matches[0];
};
const __resolveMode = (collection, query) => {
  const q = String(query);
  const exact = collection.modes.filter(m => m.modeId === q || m.name === q);
  const matches = exact.length ? exact : collection.modes.filter(m => m.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous mode "' + q + '": ' + matches.map(m => m.name).join(', '));
  if (!matches.length) throw new Error('Mode not found: ' + q);
  return matches[0];
};
const __collectionFacts = async (c) => ({
  id: c.id, key: c.key || null, name: c.name, remote: !!c.remote,
  isExtension: !!c.isExtension, hiddenFromPublishing: !!c.hiddenFromPublishing,
  defaultModeId: c.defaultModeId, modes: c.modes, variableIds: c.variableIds,
  publishStatus: await c.getPublishStatusAsync(),
});
const __variableFacts = async (v) => {
  const collection = __collections.find(c => c.id === v.variableCollectionId) || await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  return {
    id: v.id, key: v.key || null, name: v.name, description: v.description || '',
    resolvedType: v.resolvedType, remote: !!v.remote, variableCollectionId: v.variableCollectionId,
    collection: collection ? { id: collection.id, name: collection.name } : null,
    hiddenFromPublishing: !!v.hiddenFromPublishing, scopes: v.scopes,
    codeSyntax: v.codeSyntax, valuesByMode: v.valuesByMode,
    modes: collection ? collection.modes : [], publishStatus: await v.getPublishStatusAsync(),
  };
};`;
}

export {
  EASING_TYPES, MAX_VARIABLE_DESCRIPTION_CODE_UNITS, VARIABLE_SCOPES, VARIABLE_TYPES,
  normalizeVariableDescription, normalizeVariableHidden, normalizeVariableScopes,
  normalizeVariableValue, parseBoolean,
  parseVariableLiteral, parseVariableType,
};
