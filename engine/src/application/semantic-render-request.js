// Closed request Interface for the `render` command family.
//
// The parser distinguishes simple and compound Command Applications from
// named compatibility modes, but validates every route before MCP
// confirmation. That keeps old Render utility reachable without letting
// unknown flags, excess positionals or option-terminator payloads change write
// policy.

import { detectWrapperSplit } from '../lib/jsx-split.js';
import { parseResizeProbeDelta } from '../lib/semantic-resize-probe.js';

export const MAX_SEMANTIC_RENDER_JSX_CODE_UNITS = 200_000;
export const MAX_SEMANTIC_RENDER_OPTION_CODE_UNITS = 16_384;
export const MAX_SEMANTIC_RENDER_LIST_ITEMS = 100;
export const MAX_COMPOUND_RENDER_ROOTS = 100;
export const MAX_COMPOUND_RENDER_JSX_CODE_UNITS = 4_000_000;

export const SEMANTIC_RENDER_DEVICE_PRESETS = Object.freeze({
  'macbook-14': Object.freeze([1512, 982]),
  'macbook-16': Object.freeze([1728, 1117]),
  desktop: Object.freeze([1440, 1024]),
  'desktop-hd': Object.freeze([1920, 1080]),
  'iphone-15': Object.freeze([393, 852]),
  'iphone-15-pro-max': Object.freeze([430, 932]),
  'iphone-se': Object.freeze([375, 667]),
  android: Object.freeze([360, 800]),
  'ipad-11': Object.freeze([834, 1194]),
  'ipad-13': Object.freeze([1024, 1366]),
});

const OPTION_SPECS = new Map([
  ['-g', { key: 'gap', value: 'required' }],
  ['--gap', { key: 'gap', value: 'required' }],
  ['-d', { key: 'direction', value: 'required' }],
  ['--direction', { key: 'direction', value: 'required' }],
  ['-x', { key: 'x', value: 'required' }],
  ['-y', { key: 'y', value: 'required' }],
  ['--no-smart-position', { key: 'noSmartPosition', value: 'none' }],
  ['--as-component', { key: 'asComponent', value: 'none', compatibility: 'component-conversion' }],
  ['--keep-wrapper', { key: 'keepWrapper', value: 'none' }],
  ['-c', { key: 'collection', value: 'required' }],
  ['--collection', { key: 'collection', value: 'required' }],
  ['--verify', { key: 'verify', value: 'none', compatibility: 'verification-output' }],
  ['--verification-output-dir', { key: 'verificationOutputDir', value: 'required' }],
  ['--preset', { key: 'preset', value: 'required' }],
  ['--icons', { key: 'icons', value: 'required', compatibility: 'project-icons' }],
  ['--dom-capture', { key: 'domCapture', value: 'required', compatibility: 'dom-capture' }],
  ['--manifest', { key: 'manifest', value: 'required' }],
  ['--print-browser-capture', { key: 'printBrowserCapture', value: 'optional', compatibility: 'browser-capture-expression' }],
  ['--structural-gate', { key: 'structuralGate', value: 'none', compatibility: 'structural-gate' }],
  ['--resize-probe', { key: 'resizeProbe', value: 'optional', compatibility: 'resize-probe' }],
  ['--approve-fallback', { key: 'approveFallback', value: 'required' }],
  ['--allow-free-layout', { key: 'allowFreeLayout', value: 'required' }],
  ['--help', { key: 'help', value: 'none' }],
  ['-h', { key: 'help', value: 'none' }],
]);

const BATCH_OPTION_SPECS = new Map([
  ['-g', { key: 'gap', value: 'required' }],
  ['--gap', { key: 'gap', value: 'required' }],
  ['-d', { key: 'direction', value: 'required' }],
  ['--direction', { key: 'direction', value: 'required' }],
  ['-x', { key: 'x', value: 'required' }],
  ['-y', { key: 'y', value: 'required' }],
  ['--no-smart-position', { key: 'noSmartPosition', value: 'none' }],
  ['--as-component', { key: 'asComponent', value: 'none' }],
  ['-c', { key: 'collection', value: 'required' }],
  ['--collection', { key: 'collection', value: 'required' }],
  ['--verify', { key: 'verify', value: 'none' }],
  ['--verification-output-dir', { key: 'verificationOutputDir', value: 'required' }],
  ['--preset', { key: 'preset', value: 'required' }],
  ['--icons', { key: 'icons', value: 'required' }],
  ['--manifest', { key: 'manifest', value: 'required' }],
  ['--resize-probe', { key: 'resizeProbe', value: 'optional' }],
  ['--approve-fallback', { key: 'approveFallback', value: 'required' }],
  ['--allow-free-layout', { key: 'allowFreeLayout', value: 'required' }],
  ['--help', { key: 'help', value: 'none' }],
  ['-h', { key: 'help', value: 'none' }],
]);

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;

function requestError(message) {
  return new Error(`Invalid render command: ${message}.`);
}

function boundedOption(value, label) {
  if (typeof value !== 'string') throw requestError(`${label} must be a string`);
  if (value.length === 0) throw requestError(`${label} must not be empty`);
  if (value.length > MAX_SEMANTIC_RENDER_OPTION_CODE_UNITS) {
    throw requestError(`${label} must be at most ${MAX_SEMANTIC_RENDER_OPTION_CODE_UNITS} code units`);
  }
  return value;
}

function csv(value, label) {
  const items = boundedOption(value, label)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) throw requestError(`${label} must contain at least one value`);
  const unique = [...new Set(items)];
  if (unique.length > MAX_SEMANTIC_RENDER_LIST_ITEMS) {
    throw requestError(`${label} must contain at most ${MAX_SEMANTIC_RENDER_LIST_ITEMS} unique values`);
  }
  return unique;
}

function imageIntent(jsx) {
  const localPaths = [];
  let remoteCount = 0;
  let embeddedCount = 0;
  const attributes = String(jsx).matchAll(/\b(?:src|image)\s*=\s*(?:"([^"]*)"|{([^}]*)})/g);
  for (const match of attributes) {
    let value = (match[1] ?? match[2] ?? '').trim();
    const nestedQuote = /^(?:"([^"]*)"|'([^']*)')$/.exec(value);
    if (nestedQuote) value = nestedQuote[1] ?? nestedQuote[2];
    if (/^https?:/i.test(value)) remoteCount++;
    else if (/^(?:imgref:|data:)/i.test(value)) embeddedCount++;
    else if (IMAGE_EXT.test(value)) localPaths.push(value);
  }
  return Object.freeze({
    localPaths: Object.freeze([...new Set(localPaths)]),
    remoteCount,
    embeddedCount,
  });
}

function combinedImageIntent(roots) {
  const localPaths = new Set();
  let remoteCount = 0;
  let embeddedCount = 0;
  for (const root of roots) {
    const intent = imageIntent(root);
    for (const path of intent.localPaths) localPaths.add(path);
    remoteCount += intent.remoteCount;
    embeddedCount += intent.embeddedCount;
  }
  return Object.freeze({
    localPaths: Object.freeze([...localPaths]),
    remoteCount,
    embeddedCount,
  });
}

function normalizedOptionToken(token) {
  if (OPTION_SPECS.has(token)) return { name: token, inlineValue: null };
  const combined = /^(--[a-z][a-z-]*)=(.*)$/i.exec(token);
  if (combined && OPTION_SPECS.has(combined[1])) {
    return { name: combined[1], inlineValue: combined[2] };
  }
  // Commander accepts attached values for these short value flags.
  const short = /^(-[gdxyc])(.+)$/.exec(token);
  if (short && OPTION_SPECS.has(short[1])) {
    return { name: short[1], inlineValue: short[2] };
  }
  return null;
}

function normalizedBatchOptionToken(token) {
  if (BATCH_OPTION_SPECS.has(token)) return { name: token, inlineValue: null };
  const combined = /^(--[a-z][a-z-]*)=(.*)$/i.exec(token);
  if (combined && BATCH_OPTION_SPECS.has(combined[1])) {
    return { name: combined[1], inlineValue: combined[2] };
  }
  const short = /^(-[gdxyc])(.+)$/.exec(token);
  if (short && BATCH_OPTION_SPECS.has(short[1])) {
    return { name: short[1], inlineValue: short[2] };
  }
  return null;
}

function finiteOption(value, label, { min = -1_000_000, max = 1_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw requestError(`${label} must be a finite number from ${min} to ${max}`);
  }
  return number;
}

function normalizeDirection(value) {
  const direction = String(value || 'row').toLowerCase();
  if (['row', 'horizontal'].includes(direction)) return 'row';
  if (['col', 'column', 'vertical'].includes(direction)) return 'col';
  throw requestError('--direction must be row or col');
}

function compoundRequest({ source, roots, sourceJsx = null, direction, values }) {
  const total = roots.reduce((sum, root) => sum + root.length, 0);
  if (!roots.length) throw requestError('compound render needs at least one JSX root');
  if (roots.length > MAX_COMPOUND_RENDER_ROOTS) {
    throw requestError(`compound render accepts at most ${MAX_COMPOUND_RENDER_ROOTS} roots`);
  }
  if (roots.some((root) => typeof root !== 'string' || root.length === 0
    || root.length > MAX_SEMANTIC_RENDER_JSX_CODE_UNITS)) {
    throw requestError(`every compound JSX root must contain 1 to ${MAX_SEMANTIC_RENDER_JSX_CODE_UNITS} code units`);
  }
  if (total > MAX_COMPOUND_RENDER_JSX_CODE_UNITS) {
    throw requestError(`compound JSX must be at most ${MAX_COMPOUND_RENDER_JSX_CODE_UNITS} code units in total`);
  }
  const gap = finiteOption(values.gap ?? 40, '--gap', { min: 0, max: 10_000 });
  const x = values.x === undefined ? null : finiteOption(values.x, '-x');
  const y = values.y === undefined ? null : finiteOption(values.y, '-y');
  const resizeDelta = values.resizeProbe === undefined
    ? null
    : parseResizeProbeDelta(values.resizeProbe);
  return Object.freeze({
    source,
    sourceJsx,
    roots: Object.freeze([...roots]),
    layout: Object.freeze({ direction: normalizeDirection(direction), gap }),
    placement: Object.freeze({
      smart: values.noSmartPosition !== true,
      x,
      y,
    }),
    collection: values.collection || null,
    preset: values.preset || null,
    icons: values.icons || null,
    manifest: values.manifest || null,
    approvedFallbacks: Object.freeze(values.approveFallback || []),
    allowedFreePaths: Object.freeze(values.allowFreeLayout || []),
    stages: Object.freeze({
      componentConversion: values.asComponent === true,
      resizeProbe: resizeDelta,
      verification: values.verify === true,
      verificationDirectory: values.verificationOutputDir || null,
    }),
    assets: combinedImageIntent(roots),
  });
}

function inspectRenderArgv(args) {
  if (!Array.isArray(args) || args[0] !== 'render') {
    throw new Error('Expected a render command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Render arguments must be strings.');
  }

  const values = {};
  const compatibility = new Set();
  const positionals = [];
  const seen = new Set();
  let literal = false;

  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (literal || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const normalized = normalizedOptionToken(token);
    if (!normalized) throw requestError(`unknown option ${token}`);
    const spec = OPTION_SPECS.get(normalized.name);
    if (seen.has(spec.key)) throw requestError(`duplicate option ${normalized.name}`);
    seen.add(spec.key);
    if (spec.compatibility) compatibility.add(spec.compatibility);

    if (spec.value === 'none') {
      if (normalized.inlineValue !== null) throw requestError(`${normalized.name} does not take a value`);
      values[spec.key] = true;
      continue;
    }

    let value = normalized.inlineValue;
    if (value === null) {
      const next = args[index + 1];
      const numericFlagValue = (spec.key === 'gap' || spec.key === 'x' || spec.key === 'y')
        && typeof next === 'string' && Number.isFinite(Number(next));
      const mayConsume = typeof next === 'string'
        && next !== '--'
        && !normalizedOptionToken(next)
        && (!next.startsWith('-') || numericFlagValue);
      if (mayConsume) {
        value = next;
        index++;
      } else if (spec.value === 'optional') {
        value = true;
      } else {
        throw requestError(`${normalized.name} requires a value`);
      }
    }
    if (value !== true) boundedOption(value, normalized.name);
    values[spec.key] = value;
  }

  if (positionals.length > 1) {
    throw requestError(`unexpected argument ${positionals[1]}`);
  }
  const jsx = positionals[0];
  if (jsx !== undefined) {
    if (jsx.length === 0) throw requestError('JSX must not be empty');
    if (jsx.length > MAX_SEMANTIC_RENDER_JSX_CODE_UNITS) {
      throw requestError(`JSX must be at most ${MAX_SEMANTIC_RENDER_JSX_CODE_UNITS} code units`);
    }
  }

  if (values.preset !== undefined && !Object.hasOwn(SEMANTIC_RENDER_DEVICE_PRESETS, values.preset)) {
    throw requestError(`unknown preset ${values.preset}`);
  }
  for (const key of ['x', 'y']) {
    if (values[key] !== undefined && !Number.isFinite(Number(values[key]))) {
      throw requestError(`-${key} must be a finite number`);
    }
  }
  if (values.resizeProbe !== undefined) {
    try { parseResizeProbeDelta(values.resizeProbe); }
    catch (error) { throw requestError(error.message); }
  }
  if (values.verificationOutputDir !== undefined) {
    values.verificationOutputDir = boundedOption(values.verificationOutputDir, '--verification-output-dir');
    if (!values.verify) throw requestError('--verification-output-dir requires --verify');
  }
  if (values.collection !== undefined) values.collection = boundedOption(values.collection.trim(), '--collection');
  if (values.manifest !== undefined) values.manifest = boundedOption(values.manifest, '--manifest');
  if (values.approveFallback !== undefined) values.approveFallback = csv(values.approveFallback, '--approve-fallback');
  if (values.allowFreeLayout !== undefined) values.allowFreeLayout = csv(values.allowFreeLayout, '--allow-free-layout');

  if (values.help) {
    return Object.freeze({ kind: 'help', mutatesDesign: false, target: 'none', values, jsx: jsx ?? null });
  }
  if (values.printBrowserCapture) {
    return Object.freeze({ kind: 'compatibility', reason: 'browser-capture-expression', mutatesDesign: false, target: 'none', values, jsx: jsx ?? null });
  }
  if (jsx === undefined && values.domCapture === undefined) {
    throw requestError('pass JSX or --dom-capture <file>');
  }
  if (values.structuralGate) {
    return Object.freeze({ kind: 'compatibility', reason: 'structural-gate', mutatesDesign: false, target: 'none', values, jsx: jsx ?? null });
  }
  if (values.domCapture !== undefined) {
    return Object.freeze({ kind: 'compatibility', reason: 'dom-capture', mutatesDesign: true, target: 'figma', values, jsx: jsx ?? null });
  }
  const split = !values.keepWrapper ? detectWrapperSplit(jsx) : null;
  if (split) {
    const request = compoundRequest({
      source: 'auto-split', roots: split.children, sourceJsx: jsx,
      direction: values.direction || split.direction, values,
    });
    return Object.freeze({
      kind: 'compound', reason: 'auto-split', mutatesDesign: true,
      target: 'figma', values, jsx, request,
    });
  }
  if (values.gap !== undefined || values.direction !== undefined) {
    throw requestError('--gap and --direction require an auto-split wrapper');
  }
  if (values.verify) {
    const request = compoundRequest({
      source: 'single-root', roots: [jsx], sourceJsx: jsx, direction: 'row', values,
    });
    return Object.freeze({
      kind: 'compound', reason: 'single-root-stages', mutatesDesign: true,
      target: 'figma', values, jsx, request,
    });
  }
  if (compatibility.size) {
    return Object.freeze({ kind: 'compatibility', reason: [...compatibility][0], mutatesDesign: true, target: 'figma', values, jsx });
  }
  const assets = imageIntent(jsx);
  if (assets.localPaths.length || assets.remoteCount || assets.embeddedCount) {
    return Object.freeze({ kind: 'compatibility', reason: 'image-resolution', mutatesDesign: true, target: 'figma', values, jsx });
  }

  return Object.freeze({
    kind: 'simple',
    reason: null,
    mutatesDesign: true,
    target: 'figma',
    values,
    jsx,
    request: Object.freeze({
      jsx,
      keepWrapper: values.keepWrapper === true,
      placement: Object.freeze({
        smart: values.noSmartPosition !== true,
        x: values.x === undefined ? null : finiteOption(values.x, '-x'),
        y: values.y === undefined ? null : finiteOption(values.y, '-y'),
      }),
      collection: values.collection || null,
      preset: values.preset || null,
      manifest: values.manifest || null,
      approvedFallbacks: Object.freeze(values.approveFallback || []),
      allowedFreePaths: Object.freeze(values.allowFreeLayout || []),
    }),
  });
}

function inspectRenderBatchArgv(args) {
  if (!Array.isArray(args) || args[0] !== 'render-batch') throw new Error('Expected a render-batch command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Render arguments must be strings.');
  const values = {};
  const positionals = [];
  const seen = new Set();
  let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (literal || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const normalized = normalizedBatchOptionToken(token);
    if (!normalized) throw requestError(`unknown option ${token}`);
    const spec = BATCH_OPTION_SPECS.get(normalized.name);
    if (seen.has(spec.key)) throw requestError(`duplicate option ${normalized.name}`);
    seen.add(spec.key);
    if (spec.value === 'none') {
      if (normalized.inlineValue !== null) throw requestError(`${normalized.name} does not take a value`);
      values[spec.key] = true;
      continue;
    }
    let value = normalized.inlineValue;
    if (value === null) {
      const next = args[index + 1];
      const numeric = ['gap', 'x', 'y'].includes(spec.key)
        && typeof next === 'string' && Number.isFinite(Number(next));
      const mayConsume = typeof next === 'string' && next !== '--'
        && !normalizedBatchOptionToken(next) && (!next.startsWith('-') || numeric);
      if (mayConsume) { value = next; index++; }
      else if (spec.value === 'optional') value = true;
      else throw requestError(`${normalized.name} requires a value`);
    }
    if (value !== true) boundedOption(value, normalized.name);
    values[spec.key] = value;
  }
  if (values.help) {
    return Object.freeze({ kind: 'help', reason: null, mutatesDesign: false, target: 'none', values });
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'render-batch needs one JSON array');
  }
  if (positionals[0].length > MAX_COMPOUND_RENDER_JSX_CODE_UNITS + 100_000) {
    throw requestError('render-batch JSON exceeds the compound request limit');
  }
  let roots;
  try { roots = JSON.parse(positionals[0]); }
  catch { throw requestError('render-batch argument must be valid JSON'); }
  if (!Array.isArray(roots)) throw requestError('render-batch argument must be a JSON array');
  if (values.preset !== undefined && !Object.hasOwn(SEMANTIC_RENDER_DEVICE_PRESETS, values.preset)) {
    throw requestError(`unknown preset ${values.preset}`);
  }
  if (values.collection !== undefined) values.collection = boundedOption(values.collection.trim(), '--collection');
  if (values.manifest !== undefined) values.manifest = boundedOption(values.manifest, '--manifest');
  if (values.icons !== undefined) values.icons = boundedOption(values.icons, '--icons');
  if (values.verificationOutputDir !== undefined) {
    values.verificationOutputDir = boundedOption(values.verificationOutputDir, '--verification-output-dir');
    if (!values.verify) throw requestError('--verification-output-dir requires --verify');
  }
  if (values.approveFallback !== undefined) values.approveFallback = csv(values.approveFallback, '--approve-fallback');
  if (values.allowFreeLayout !== undefined) values.allowFreeLayout = csv(values.allowFreeLayout, '--allow-free-layout');
  const request = compoundRequest({
    source: 'explicit-batch', roots, direction: values.direction || 'row', values,
  });
  return Object.freeze({
    kind: 'compound', reason: 'explicit-batch', mutatesDesign: true,
    target: 'figma', values, request,
  });
}

function inspectSemanticRenderArgv(args) {
  return args?.[0] === 'render-batch' ? inspectRenderBatchArgv(args) : inspectRenderArgv(args);
}

/** Validate all currently supported Render syntax before confirmation. */
export function acceptsSemanticRenderArgv(args) {
  try {
    inspectSemanticRenderArgv(args);
    return true;
  } catch {
    return false;
  }
}

/** Closed policy projection used by the Capability Catalog. */
export function semanticRenderPolicyFromArgv(args) {
  const inspected = inspectSemanticRenderArgv(args);
  const reason = 'reason' in inspected ? inspected.reason : null;
  return Object.freeze({
    kind: inspected.kind,
    reason: reason || null,
    mutatesDesign: inspected.mutatesDesign,
    target: inspected.target,
  });
}

/** Return the typed request only for the shared single-root Application. */
export function semanticRenderRequestFromArgv(args) {
  const inspected = inspectRenderArgv(args);
  if (inspected.kind !== 'simple') {
    const reason = 'reason' in inspected ? inspected.reason : null;
    throw requestError(`request belongs to the ${reason || inspected.kind} compatibility Adapter`);
  }
  return inspected.request;
}

/** Return the typed request only for auto-split or explicit batch rendering. */
export function semanticCompoundRenderRequestFromArgv(args) {
  const inspected = inspectSemanticRenderArgv(args);
  if (inspected.kind !== 'compound') {
    const reason = 'reason' in inspected ? inspected.reason : inspected.kind;
    throw requestError(`request belongs to the ${reason || 'simple'} Render Adapter`);
  }
  return inspected.request;
}

/** Asset classification is policy input, never inferred after confirmation. */
export function semanticRenderAssetIntentFromArgv(args) {
  const inspected = inspectSemanticRenderArgv(args);
  if (inspected.kind === 'compound') return inspected.request.assets;
  const jsx = 'jsx' in inspected ? inspected.jsx || '' : '';
  return imageIntent(jsx);
}

/** Route a valid Render argv without executing or reading external state. */
export function semanticRenderArgvRoute(args) {
  const inspected = inspectSemanticRenderArgv(args);
  const reason = 'reason' in inspected ? inspected.reason : null;
  return Object.freeze({ kind: inspected.kind, reason: reason || null });
}

function compoundOptions(request) {
  const options = [];
  if (request.layout.gap !== 40) options.push(`--gap=${request.layout.gap}`);
  if (request.source === 'auto-split' || request.layout.direction !== 'row') {
    options.push(`--direction=${request.layout.direction}`);
  }
  if (request.placement.x !== null) options.push(`-x${request.placement.x}`);
  if (request.placement.y !== null) options.push(`-y${request.placement.y}`);
  if (!request.placement.smart) options.push('--no-smart-position');
  if (request.stages.componentConversion) options.push('--as-component');
  if (request.stages.verification) options.push('--verify');
  if (request.stages.verificationDirectory) {
    options.push(`--verification-output-dir=${request.stages.verificationDirectory}`);
  }
  if (request.stages.resizeProbe !== null) options.push(`--resize-probe=${request.stages.resizeProbe}`);
  if (request.collection) options.push(`--collection=${request.collection}`);
  if (request.preset) options.push(`--preset=${request.preset}`);
  if (request.icons) options.push(`--icons=${request.icons}`);
  if (request.manifest) options.push(`--manifest=${request.manifest}`);
  if (request.approvedFallbacks.length) options.push(`--approve-fallback=${request.approvedFallbacks.join(',')}`);
  if (request.allowedFreePaths.length) options.push(`--allow-free-layout=${request.allowedFreePaths.join(',')}`);
  return options;
}

/** Canonical argv for both compound entry points without changing their intent source. */
export function semanticCompoundRenderArgvFromRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.roots)) {
    throw new TypeError('Compound Semantic Render request must be an object.');
  }
  const options = compoundOptions(request);
  const args = request.source === 'auto-split' || request.source === 'single-root'
    ? ['render', request.sourceJsx, ...options]
    : ['render-batch', JSON.stringify(request.roots), ...options];
  const inspected = inspectSemanticRenderArgv(args);
  if (inspected.kind !== 'compound') throw requestError('typed request is not a compound render');
  return args;
}

/** Canonical argv for equivalent typed single-root requests. */
export function semanticRenderArgvFromRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Semantic Render request must be an object.');
  if (typeof request.jsx !== 'string') throw requestError('JSX must be a string');
  const options = [];
  if (request.keepWrapper === true) options.push('--keep-wrapper');
  if (request.placement?.x !== null && request.placement?.x !== undefined) {
    options.push(`-x${finiteOption(request.placement.x, '-x')}`);
  }
  if (request.placement?.y !== null && request.placement?.y !== undefined) {
    options.push(`-y${finiteOption(request.placement.y, '-y')}`);
  }
  if (request.placement?.smart === false) options.push('--no-smart-position');
  // Inline option values preserve the full accepted value range, including a
  // legitimate leading dash, when typed requests round-trip through argv.
  if (request.collection != null) options.push(`--collection=${String(request.collection)}`);
  if (request.preset != null) options.push(`--preset=${String(request.preset)}`);
  if (request.manifest != null) options.push(`--manifest=${String(request.manifest)}`);
  if (Array.isArray(request.approvedFallbacks) && request.approvedFallbacks.length) {
    options.push(`--approve-fallback=${request.approvedFallbacks.join(',')}`);
  }
  if (Array.isArray(request.allowedFreePaths) && request.allowedFreePaths.length) {
    options.push(`--allow-free-layout=${request.allowedFreePaths.join(',')}`);
  }
  // A leading dash is valid literal JSX input only behind the option
  // terminator. Keep all canonical options before that boundary so adding a
  // default manifest can never reinterpret the payload as policy.
  const args = request.jsx.startsWith('-')
    ? ['render', ...options, '--', request.jsx]
    : ['render', request.jsx, ...options];
  const inspected = inspectRenderArgv(args);
  if (inspected.kind !== 'simple') throw requestError('typed request is not a simple single-root render');
  return args;
}
