// Pure, bounded source normalization for Single-Collection Token Import.

import { parseBoundedJson } from '../lib/workspace-io.js';
import { normalizeVariableValue, parseVariableType } from '../lib/variable-management.js';
import { VARIABLE_SCOPES_BY_TYPE } from '../lib/variable-scope-policy.js';

export const MAX_TOKEN_IMPORT_ITEMS = 10_000;
export const MAX_TOKEN_IMPORT_NAME_CODE_UNITS = 512;
export const MAX_TOKEN_IMPORT_STRING_CODE_UNITS = 16_384;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const META_KEYS = new Set(['$description', '$extensions']);

function sourceError(message) { return new Error(`Invalid token import source: ${message}.`); }

function tokenName(parts) {
  const name = parts.join('/');
  if (!name || name.length > MAX_TOKEN_IMPORT_NAME_CODE_UNITS || UNSAFE_CONTROLS.test(name)) {
    throw sourceError('token name is empty, unsafe, or too long');
  }
  return name;
}

function mappedType(value, declared) {
  const raw = declared == null ? null : String(declared).trim().toUpperCase();
  const mapped = raw === 'NUMBER' || raw === 'DIMENSION' ? 'FLOAT' : raw;
  if (mapped) {
    try { return parseVariableType(mapped); } catch { throw sourceError(`unsupported token type ${declared}`); }
  }
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') return 'FLOAT';
  if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) return 'COLOR';
  if (typeof value === 'string') return 'STRING';
  throw sourceError('token type cannot be inferred from a composite value');
}

function dimensionValue(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['value', 'unit'].includes(key))
    && typeof value.value === 'number' && Number.isFinite(value.value)) {
    if (String(value.unit).toLowerCase() === 'px') return value.value;
    if (String(value.unit).toLowerCase() === 'rem') return value.value * 16;
    throw sourceError('dimension object unit must be px or rem');
  }
  const match = typeof value === 'string' && value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))px$/i);
  if (!match) throw sourceError('dimension values must be finite pixel numbers');
  return Number(match[1]);
}

function normalizedValue(value, type, declared) {
  let candidate = String(declared || '').toLowerCase() === 'dimension' ? dimensionValue(value) : value;
  if (type === 'COLOR' && typeof candidate === 'object' && candidate && !Array.isArray(candidate)
    && Array.isArray(candidate.components) && candidate.components.length === 3) {
    if (String(candidate.colorSpace || '').toLowerCase() !== 'srgb') {
      if (typeof candidate.hex !== 'string') {
        throw sourceError('non-sRGB colors require an explicit hex fallback');
      }
      candidate = candidate.hex;
    } else {
      const [r, g, b] = candidate.components;
      candidate = { r, g, b, ...(candidate.alpha === undefined ? {} : { a: candidate.alpha }) };
    }
  }
  try { candidate = normalizeVariableValue(candidate, type); }
  catch (error) { throw sourceError(error.message); }
  if (type === 'STRING' && candidate.length > MAX_TOKEN_IMPORT_STRING_CODE_UNITS) {
    throw sourceError(`STRING value exceeds ${MAX_TOKEN_IMPORT_STRING_CODE_UNITS} code units`);
  }
  return candidate;
}

function metadata(leaf) {
  const bridge = leaf.$extensions?.['figma-bridge-mcp'];
  const scopes = leaf.scopes ?? bridge?.scopes ?? leaf.$extensions?.figma?.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 32
    || scopes.some((scope) => typeof scope !== 'string' || !scope)
    || new Set(scopes).size !== scopes.length)) {
    throw sourceError('scopes must be a bounded string array');
  }
  const codeSyntax = leaf.codeSyntax ?? bridge?.codeSyntax ?? leaf.$extensions?.figma?.codeSyntax;
  if (codeSyntax !== undefined && (!codeSyntax || typeof codeSyntax !== 'object'
    || Array.isArray(codeSyntax) || Object.keys(codeSyntax).some((key) =>
      !['WEB', 'ANDROID', 'iOS'].includes(key) || typeof codeSyntax[key] !== 'string'
      || codeSyntax[key].length > 1_024))) {
    throw sourceError('codeSyntax must contain only bounded WEB, ANDROID, or iOS strings');
  }
  return {
    ...(scopes === undefined ? {} : { scopes: [...scopes] }),
    ...(codeSyntax === undefined ? {} : { codeSyntax: { ...codeSyntax } }),
  };
}

function aliasName(value) {
  const match = typeof value === 'string' && value.match(/^\{([^{}]+)\}$/);
  return match ? tokenName(match[1].split('.')) : null;
}

export function normalizeTokenImportSource(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw sourceError('root must be an object');
  }
  const items = [];
  const visit = (node, parts, inheritedType = null) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      const name = tokenName(parts);
      const type = mappedType(node, inheritedType);
      items.push({ name, type, value: normalizedValue(node, type, inheritedType) });
      return;
    }
    const hasDtcgValue = Object.hasOwn(node, '$value');
    const hasLegacyValue = Object.hasOwn(node, 'value');
    const hasValue = hasDtcgValue || hasLegacyValue;
    const declared = node.$type ?? node.type ?? inheritedType;
    if (hasValue) {
      const raw = hasDtcgValue ? node.$value : node.value;
      const name = tokenName(parts);
      const type = mappedType(raw, declared);
      const alias = aliasName(raw);
      items.push({ name, type, ...(alias ? { alias } : { value: normalizedValue(raw, type, declared) }), ...metadata(node) });
      return;
    }
    const entries = Object.entries(node).filter(([key]) => !META_KEYS.has(key) && key !== '$type' && key !== 'type');
    if (!entries.length) throw sourceError(`group ${parts.join('/') || '(root)'} has no tokens`);
    for (const [key, child] of entries) visit(child, [...parts, key], declared);
  };
  for (const [key, value] of Object.entries(document)) {
    if (!META_KEYS.has(key) && key !== '$type' && key !== 'type') visit(value, [key], document.$type ?? document.type ?? null);
  }
  return normalizeTokenImportItems(items);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

export function normalizeTokenImportItems(input) {
  if (!Array.isArray(input) || !input.length) throw sourceError('at least one token is required');
  if (input.length > MAX_TOKEN_IMPORT_ITEMS) throw sourceError(`at most ${MAX_TOKEN_IMPORT_ITEMS} tokens are accepted`);
  const items = input.map((raw) => {
    const alias = Object.hasOwn(raw || {}, 'alias');
    if (!exactKeys(raw, ['name', 'type', alias ? 'alias' : 'value'], ['scopes', 'codeSyntax'])
      || alias === Object.hasOwn(raw || {}, 'value')) {
      throw sourceError('prepared token item has an invalid closed shape');
    }
    if (typeof raw.name !== 'string' || (alias && typeof raw.alias !== 'string')) {
      throw sourceError('prepared token names and aliases must be strings');
    }
    const name = tokenName(raw.name.split('/'));
    let type;
    try { type = parseVariableType(raw.type); } catch { throw sourceError(`token ${name} has an invalid type`); }
    const meta = metadata(raw);
    return { name, type, ...(alias
      ? { alias: tokenName(raw.alias.split('/')) }
      : { value: normalizedValue(raw.value, type, type) }), ...meta };
  });
  const names = new Set();
  for (const item of items) {
    if (names.has(item.name)) throw sourceError(`duplicate token name ${item.name}`);
    names.add(item.name);
  }
  const byName = new Map(items.map((item) => [item.name, item]));
  for (const item of items) {
    if (item.alias && !names.has(item.alias)) throw sourceError(`alias ${item.name} targets missing token ${item.alias}`);
    if (item.alias) {
      const target = byName.get(item.alias);
      if (target.type !== item.type) throw sourceError(`alias ${item.name} has incompatible target type`);
    }
    if (item.scopes && (!Object.hasOwn(VARIABLE_SCOPES_BY_TYPE, item.type)
      || item.scopes.some((scope) => !VARIABLE_SCOPES_BY_TYPE[item.type].includes(scope)))) {
      throw sourceError(`token ${item.name} has a scope incompatible with ${item.type}`);
    }
  }
  const aliasState = new Map();
  for (const item of items) {
    if (aliasState.get(item.name) === 'done') continue;
    const path = [];
    let cursor = item;
    while (cursor?.alias) {
      if (aliasState.get(cursor.name) === 'visiting') {
        throw sourceError(`alias cycle includes ${cursor.name}`);
      }
      if (aliasState.get(cursor.name) === 'done') break;
      aliasState.set(cursor.name, 'visiting');
      path.push(cursor.name);
      cursor = byName.get(cursor.alias);
    }
    for (const name of path) aliasState.set(name, 'done');
    if (cursor) aliasState.set(cursor.name, 'done');
  }
  return deepFreeze(items.map((item) => ({ ...item })));
}

export function readTokenImportSource(request, workspaceIO) {
  if (!workspaceIO || typeof workspaceIO.readText !== 'function') {
    throw new TypeError('Token Import source preparation requires WorkspaceIO.');
  }
  const text = workspaceIO.readText(request.file, { role: 'token-file' });
  const document = parseBoundedJson(text, { role: 'token-file', limits: workspaceIO.limits });
  return normalizeTokenImportSource(document);
}
