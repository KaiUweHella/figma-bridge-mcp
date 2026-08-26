// Bounded source-fact acceptance against one real browser DOM capture.
//
// The ledger deliberately carries the human-reviewed mapping from a Figma
// source node to one stable browser target. This module owns only mechanical
// comparison: every fact becomes matched, approved-deviation or missing.

import { CAPTURE_STYLE_PROPERTIES } from './browser-dom-capture.js';

export const BROWSER_FIDELITY_LEDGER_VERSION = 1;
export const MAX_BROWSER_FIDELITY_FACTS = 500;

const STYLE_PROPERTIES = new Set(CAPTURE_STYLE_PROPERTIES);
const SHA256 = /^[a-f0-9]{64}$/;
const NODE_ID = /^I?\d+:\d+(?:;\d+:\d+)*$/;
const FACT_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const MAX_FACT_VALUE_CODE_UNITS = 4096;
const MAX_CAPTURE_NODE_NAME_CODE_UNITS = 256;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function error(message) {
  return new Error(`Invalid browser fidelity ledger: ${message}.`);
}

function normalizeString(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function nodeName(node) {
  if (!isRecord(node)) throw error('browser capture contains a non-object node');
  for (const field of ['classes', 'aria', 'tag']) {
    if (node[field] !== undefined && typeof node[field] !== 'string') {
      throw error(`browser capture node ${field} must be a string`);
    }
  }
  const name = String(node.classes || node.aria || node.tag || 'element').trim().replace(/\s+/g, '.') || 'element';
  if (name.length > MAX_CAPTURE_NODE_NAME_CODE_UNITS || UNSAFE_TEXT.test(name)) {
    throw error('browser capture node name is invalid');
  }
  return name;
}

function firstFontFamily(value) {
  return normalizeString(value).split(',')[0]?.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function factProperty(value) {
  const property = String(value || '');
  if (property === 'present' || property === 'font.loaded') return property;
  const match = property.match(/^(style|authoredStyle)\.([A-Za-z][A-Za-z0-9]*)$/);
  if (match && STYLE_PROPERTIES.has(match[2])) return property;
  if (['rect.w', 'rect.h'].includes(property)) return property;
  throw error(`unsupported fact property ${property || '(missing)'}`);
}

function normalizeTarget(raw, label) {
  if (!isRecord(raw)) throw error(`${label} target must be an object`);
  const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : null;
  const entity = typeof raw.entity === 'string' && raw.entity.trim() ? raw.entity.trim() : null;
  if ((path ? 1 : 0) + (entity ? 1 : 0) !== 1) {
    throw error(`${label} target needs exactly one path or entity`);
  }
  if (path && (path.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(path))) {
    throw error(`${label} target path is invalid`);
  }
  if (entity && !FACT_ID.test(entity)) throw error(`${label} target entity is invalid`);
  const occurrence = raw.occurrence === undefined ? null : Number(raw.occurrence);
  if (occurrence !== null && (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > 10_000)) {
    throw error(`${label} target occurrence must be a positive integer`);
  }
  return Object.freeze({ ...(path ? { path } : { entity }), ...(occurrence ? { occurrence } : {}) });
}

function normalizeExpected(value, property, label) {
  if (property === 'present' || property === 'font.loaded') {
    if (typeof value !== 'boolean') throw error(`${label} expected value must be boolean`);
    return value;
  }
  if (['rect.w', 'rect.h'].includes(property)) {
    if (!Number.isFinite(Number(value))) throw error(`${label} expected value must be finite`);
    return Number(value);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw error(`${label} expected value must be a string or number`);
  }
  if (typeof value === 'string'
    && (value.length > MAX_FACT_VALUE_CODE_UNITS || UNSAFE_TEXT.test(value))) {
    throw error(`${label} expected value is invalid`);
  }
  return value;
}

export function normalizeBrowserFidelityLedger(value) {
  if (!isRecord(value) || value.schemaVersion !== BROWSER_FIDELITY_LEDGER_VERSION) {
    throw error(`schemaVersion must be ${BROWSER_FIDELITY_LEDGER_VERSION}`);
  }
  if (!Array.isArray(value.facts) || !value.facts.length
    || value.facts.length > MAX_BROWSER_FIDELITY_FACTS) {
    throw error(`facts must contain 1-${MAX_BROWSER_FIDELITY_FACTS} entries`);
  }
  if (value.sourceRootNodeId !== undefined
    && (typeof value.sourceRootNodeId !== 'string' || !NODE_ID.test(value.sourceRootNodeId))) {
    throw error('sourceRootNodeId is invalid');
  }
  const ids = new Set();
  const facts = value.facts.map((raw, index) => {
    const label = `facts[${index}]`;
    if (!isRecord(raw) || typeof raw.id !== 'string' || !FACT_ID.test(raw.id)) {
      throw error(`${label} id is invalid`);
    }
    if (ids.has(raw.id)) throw error(`${label} duplicates id ${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.sourceNodeId !== 'string' || !NODE_ID.test(raw.sourceNodeId)) {
      throw error(`${label} sourceNodeId is invalid`);
    }
    const property = factProperty(raw.property);
    const expected = normalizeExpected(raw.expected, property, label);
    const tolerance = raw.tolerance === undefined ? null : Number(raw.tolerance);
    if (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1_000_000)) {
      throw error(`${label} tolerance must be a non-negative finite number`);
    }
    let approvedDeviation = null;
    if (raw.approvedDeviation !== undefined) {
      const reason = raw.approvedDeviation?.reason;
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500 || UNSAFE_TEXT.test(reason)) {
        throw error(`${label} approvedDeviation requires a bounded reason`);
      }
      approvedDeviation = Object.freeze({ reason: reason.trim() });
    }
    return Object.freeze({
      id: raw.id,
      sourceNodeId: raw.sourceNodeId,
      target: normalizeTarget(raw.target, label),
      property,
      expected,
      ...(tolerance !== null ? { tolerance } : {}),
      ...(approvedDeviation ? { approvedDeviation } : {}),
    });
  });
  return Object.freeze({
    schemaVersion: BROWSER_FIDELITY_LEDGER_VERSION,
    ...(typeof value.sourceRootNodeId === 'string' ? { sourceRootNodeId: value.sourceRootNodeId } : {}),
    facts: Object.freeze(facts),
  });
}

function captureIndex(capture) {
  if (!isRecord(capture) || !isRecord(capture.root)) throw error('browser capture root is missing');
  const byPath = new Map();
  const byEntity = new Map();
  const visit = (node, parentPath = '') => {
    const name = nodeName(node);
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(node);
    if (node.children !== undefined && !Array.isArray(node.children)) {
      throw error('browser capture node children must be an array');
    }
    const rawEntity = node.sourceIdentity?.entity;
    if (rawEntity !== undefined && rawEntity !== null && typeof rawEntity !== 'string') {
      throw error('browser capture Design Entity must be a string');
    }
    const entity = String(rawEntity || '').trim();
    if (entity) {
      if (!FACT_ID.test(entity)) throw error('browser capture Design Entity is invalid');
      if (!byEntity.has(entity)) byEntity.set(entity, []);
      byEntity.get(entity).push(node);
    }
    for (const child of node.children || []) visit(child, path);
  };
  visit(capture.root);
  return { byPath, byEntity };
}

function targetNode(target, index) {
  const values = target.path ? index.byPath.get(target.path) : index.byEntity.get(target.entity);
  if (!values?.length) return { node: null, reason: 'target-not-found' };
  if (target.occurrence) {
    return values[target.occurrence - 1]
      ? { node: values[target.occurrence - 1], reason: null }
      : { node: null, reason: 'target-occurrence-not-found' };
  }
  return values.length === 1
    ? { node: values[0], reason: null }
    : { node: null, reason: `target-ambiguous:${values.length}` };
}

function actualValue(node, property) {
  if (property === 'present') return Boolean(node);
  if (!node) return undefined;
  if (property === 'font.loaded') return node.fontEvidence?.loaded;
  const [group, key] = property.split('.');
  return node[group]?.[key];
}

function equivalent(actual, expected, fact) {
  if (actual === undefined || actual === null) return false;
  if (fact.property === 'style.fontFamily') {
    return firstFontFamily(actual) === firstFontFamily(expected);
  }
  if (typeof expected === 'number') {
    const numeric = Number(actual);
    return Number.isFinite(numeric) && Math.abs(numeric - expected) <= (fact.tolerance || 0);
  }
  if (typeof expected === 'boolean') return actual === expected;
  return normalizeString(actual) === normalizeString(expected);
}

function projectActual(value) {
  if (value === undefined || value === null) return { available: false, reason: 'property-unavailable' };
  if (typeof value === 'string') {
    if (value.length > MAX_FACT_VALUE_CODE_UNITS || UNSAFE_TEXT.test(value)) {
      return { available: false, reason: 'actual-value-invalid' };
    }
    return { available: true, value };
  }
  if (typeof value === 'boolean') return { available: true, value };
  if (typeof value === 'number' && Number.isFinite(value)) return { available: true, value };
  return { available: false, reason: 'actual-value-invalid' };
}

export function verifyBrowserFidelityLedger(ledgerInput, capture, { captureHash = null } = {}) {
  const ledger = normalizeBrowserFidelityLedger(ledgerInput);
  if (captureHash !== null && (typeof captureHash !== 'string' || !SHA256.test(captureHash))) {
    throw error('captureHash must be SHA-256');
  }
  const captureVersion = Number(capture?.version || 1);
  if (!Number.isInteger(captureVersion) || captureVersion < 1) {
    throw error('browser capture version must be a positive integer');
  }
  let viewport = null;
  if (capture?.viewport !== undefined) {
    if (!isRecord(capture.viewport)
      || !Number.isFinite(capture.viewport.width) || capture.viewport.width <= 0
      || !Number.isFinite(capture.viewport.height) || capture.viewport.height <= 0) {
      throw error('browser capture viewport must contain positive width and height');
    }
    viewport = Object.freeze({ width: capture.viewport.width, height: capture.viewport.height });
  }
  const index = captureIndex(capture);
  const facts = ledger.facts.map((fact) => {
    const target = targetNode(fact.target, index);
    const actual = projectActual(actualValue(target.node, fact.property));
    const matched = actual.available && equivalent(actual.value, fact.expected, fact);
    const status = matched ? 'matched'
      : fact.approvedDeviation ? 'approved-deviation' : 'missing';
    return Object.freeze({
      id: fact.id,
      sourceNodeId: fact.sourceNodeId,
      target: fact.target,
      property: fact.property,
      expected: fact.expected,
      ...(actual.available ? { actual: actual.value } : {}),
      status,
      ...(!matched ? { reason: target.reason || actual.reason || 'value-mismatch' } : {}),
      ...(fact.approvedDeviation ? { approval: fact.approvedDeviation } : {}),
    });
  });
  const matched = facts.filter((fact) => fact.status === 'matched').length;
  const approvedDeviations = facts.filter((fact) => fact.status === 'approved-deviation').length;
  const missing = facts.length - matched - approvedDeviations;
  return Object.freeze({
    schemaVersion: BROWSER_FIDELITY_LEDGER_VERSION,
    passed: missing === 0,
    capture: Object.freeze({
      version: captureVersion,
      ...(captureHash ? { hash: captureHash } : {}),
      ...(viewport ? { viewport } : {}),
    }),
    summary: Object.freeze({ total: facts.length, matched, approvedDeviations, missing }),
    facts: Object.freeze(facts),
  });
}
