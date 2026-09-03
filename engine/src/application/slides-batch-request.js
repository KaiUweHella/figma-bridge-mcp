// Closed request projection for bounded Figma Slides batch operations.
//
// The batch is a plan first and a mutation only on request: without `--apply`
// it resolves and validates every item and writes nothing. That default is
// deliberate. A batch concentrates several mutations behind one plugin
// dispatch, so a dispatch whose outcome is unknown leaves N operations in
// doubt rather than one -- the cheap way to find out what a batch would do
// must not be the one that performs it.

import { parseUnionReference, unionReferenceArgvValue } from './union-reference.js';

export const MAX_SLIDES_BATCH_ITEMS = 64;
export const SLIDES_BATCH_OPS = Object.freeze(['create', 'duplicate', 'move']);
export const MAX_SLIDES_BATCH_LABEL_CODE_UNITS = 4_096;
export const MAX_SLIDES_BATCH_COORDINATE = 4_095;

const OPS = new Set(SLIDES_BATCH_OPS);
const REFERENCE_OPS = new Set(['duplicate', 'move']);

function requestError(message) {
  return new Error(`Invalid Slides command: ${message}.`);
}

function coordinate(value, name, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || value > MAX_SLIDES_BATCH_COORDINATE) {
    throw requestError(`${where} ${name} must be an integer between 0 and ${MAX_SLIDES_BATCH_COORDINATE}`);
  }
  return value;
}

function labelValue(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value || value.length > MAX_SLIDES_BATCH_LABEL_CODE_UNITS) {
    throw requestError(`${where} label must be a non-empty string of at most ${MAX_SLIDES_BATCH_LABEL_CODE_UNITS} characters`);
  }
  return value;
}

function parseItem(raw, index) {
  const where = `batch item ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw requestError(`${where} must be an object`);
  }
  if (typeof raw.op !== 'string' || !OPS.has(raw.op)) {
    throw requestError(`${where} op must be one of ${SLIDES_BATCH_OPS.join(', ')}`);
  }
  const allowed = raw.op === 'create'
    ? ['op', 'label', 'row', 'col']
    : raw.op === 'duplicate'
      ? ['op', 'reference', 'label', 'row', 'col']
      : ['op', 'reference', 'row', 'col'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw requestError(`${where} contains an unknown field ${key}`);
  }

  let reference = null;
  if (REFERENCE_OPS.has(raw.op)) {
    if (typeof raw.reference !== 'string' || !raw.reference) {
      throw requestError(`${where} requires a slide reference`);
    }
    try { reference = parseUnionReference(raw.reference); }
    catch (error) { throw requestError(`${where}: ${error.message}`); }
    // A batch is single-file by construction: the Command Plan resolves one
    // target deck, so a reference carrying another file key is refused rather
    // than silently retargeted.
    if (reference.fileKey) {
      throw requestError(`${where} reference must not carry a file key; a batch runs against one deck`);
    }
  }

  const row = coordinate(raw.row, 'row', where);
  const col = coordinate(raw.col, 'col', where);
  if (col !== null && row === null) throw requestError(`${where} col requires row`);
  if (raw.op === 'move' && (row === null || col === null)) {
    throw requestError(`${where} move requires both row and col`);
  }

  return Object.freeze({
    index,
    op: raw.op,
    reference,
    label: raw.op === 'move' ? null : labelValue(raw.label, where),
    row,
    col,
  });
}

function parseItems(json) {
  let parsed;
  try { parsed = JSON.parse(json); }
  catch { throw requestError('batch payload must be JSON'); }
  if (!Array.isArray(parsed)) throw requestError('batch payload must be a JSON array');
  if (!parsed.length) throw requestError('batch payload must contain at least one item');
  if (parsed.length > MAX_SLIDES_BATCH_ITEMS) {
    throw requestError(`batch payload must contain at most ${MAX_SLIDES_BATCH_ITEMS} items`);
  }
  const items = parsed.map(parseItem);
  // Two operations on one slide make the second item's preconditions depend on
  // the first, which the plan cannot state exactly. Refuse instead of guessing.
  const targets = new Map();
  for (const item of items) {
    if (!item.reference) continue;
    const key = `${item.reference.kind} ${item.reference.value}`;
    if (targets.has(key)) {
      throw requestError(`batch items ${targets.get(key) + 1} and ${item.index + 1} target the same slide reference`);
    }
    targets.set(key, item.index);
  }
  return Object.freeze(items);
}

export function parseSlidesBatchRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || args[1] !== 'batch') {
    throw new Error('Expected a Slides batch command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides arguments must be strings.');
  }
  let apply = false;
  const positionals = [];
  const seen = new Set();
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('--')) {
      if (token !== '--apply') throw requestError(`unknown option ${token.split('=')[0]}`);
      if (seen.has(token)) throw requestError('duplicate option --apply');
      seen.add(token);
      apply = true;
      continue;
    }
    if (!literal && token.startsWith('-') && token !== '-') {
      throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError('batch requires exactly one JSON payload argument');
  }

  return Object.freeze({
    action: 'batch',
    argv: Object.freeze([...args]),
    apply,
    items: parseItems(positionals[0]),
  });
}

export function acceptsSlidesBatchArgv(args) {
  try {
    parseSlidesBatchRequest(args);
    return true;
  } catch {
    return false;
  }
}

/** Canonical argv: the payload is re-serialized from the parsed items. */
export function slidesBatchArgvFromRequest(request) {
  const input = Array.isArray(request?.argv)
    ? parseSlidesBatchRequest(request.argv)
    : request;
  if (!input || !Array.isArray(input.items)) {
    throw new TypeError('Slides batch request must be parsed before canonicalization.');
  }
  const payload = input.items.map((item) => ({
    op: item.op,
    ...(item.reference ? { reference: unionReferenceArgvValue(item.reference) } : {}),
    ...(item.label ? { label: item.label } : {}),
    ...(item.row === null ? {} : { row: item.row }),
    ...(item.col === null ? {} : { col: item.col }),
  }));
  const args = ['slides', 'batch', JSON.stringify(payload)];
  if (input.apply) args.push('--apply');
  parseSlidesBatchRequest(args);
  return args;
}

export function slidesBatchPlanningArgvFromRequest(request) {
  return slidesBatchArgvFromRequest(request);
}

/** A batch never derives its deck from a reference; it runs against one file. */
export function slidesBatchFigmaUrlFileKeyFromArgv(args) {
  parseSlidesBatchRequest(args);
  return null;
}

/** Only an explicit --apply makes the batch a design mutation. */
export function slidesBatchMutatesDesign(args) {
  return parseSlidesBatchRequest(args).apply === true;
}
