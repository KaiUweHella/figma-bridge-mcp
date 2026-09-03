// Text fidelity after a render: what Figma actually did with every text the
// plan asked for.
//
// Two things a plan cannot know before execution and that no sizing rule can
// guess: whether the requested font family and style were the ones Figma
// loaded (the native executor falls back to Inter when a family is not
// installed, and until now said nothing), and whether a run the browser set
// on one line wraps in Figma because its metrics differ. Both are measured
// here with one eval over the rendered root, matched to plan nodes through the
// `figmaBridge.semanticPath` plugin data the executor writes on every node, and
// reported as findings. Nothing is corrected silently.

import { Script } from 'node:vm';

export const MAX_TEXT_FIDELITY_NODES = 2000;
const MAX_PATH_CODE_UNITS = 4096;
const MAX_FAMILY_CODE_UNITS = 256;

// The browser capture calls a run single-line when its box is at most 1.6×
// the font size; the same rule is applied to the Figma node so both sides
// judge "one line" identically.
export const SINGLE_LINE_HEIGHT_FACTOR = 1.6;

// The executor derives a Figma style name from a CSS weight this way; a copy
// lives here because the executor file is part of the plugin bundle.
const WEIGHT_STYLES = {
  100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black',
};
const NAMED_WEIGHTS = { normal: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' };

function requestedStyle(props) {
  if (props.fontStyle != null && String(props.fontStyle).trim()) return String(props.fontStyle).trim();
  const weight = props.weight;
  const base = WEIGHT_STYLES[Number(weight)]
    || NAMED_WEIGHTS[String(weight ?? '').toLowerCase()]
    || 'Regular';
  return props.italic === true || props.italic === 'true' ? `${base} Italic` : base;
}

function normalizedStyle(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '');
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Eval source: every TEXT node under the rendered root with its live facts. */
export function semanticTextFidelityProbeCode(nodeId) {
  const id = String(nodeId || '');
  if (!/^I?\d+:\d+(?:;\d+:\d+)*$/.test(id)) throw new Error('Text fidelity probe needs a Figma node id');
  const source = `(async () => {
  const root = await figma.getNodeByIdAsync(${JSON.stringify(id)});
  if (!root) throw new Error('Text fidelity probe root is unavailable');
  const pathOf = (node) => typeof node.getPluginData === 'function'
    ? String(node.getPluginData('figmaBridge.semanticPath') || '') : '';
  const found = typeof root.findAll === 'function' ? root.findAll((node) => node.type === 'TEXT') : [];
  const texts = (root.type === 'TEXT' ? [root] : []).concat(found).slice(0, ${MAX_TEXT_FIDELITY_NODES});
  const mixed = (value) => value === figma.mixed;
  return texts.map((node) => ({
    id: node.id,
    path: pathOf(node),
    family: mixed(node.fontName) ? null : node.fontName.family,
    style: mixed(node.fontName) ? null : node.fontName.style,
    size: mixed(node.fontSize) ? null : node.fontSize,
    lineHeight: mixed(node.lineHeight) ? null : node.lineHeight,
    width: node.width,
    height: node.height,
    autoResize: node.textAutoResize,
    characters: node.characters.length,
  }));
})()`;
  new Script(source);
  return source;
}

/**
 * Every text the plan asked for, keyed by the path the executor stamps on the
 * node. `measuredLines` maps a path to the browser's line count when the plan
 * came from a DOM capture; a hand-written plan has no such measurement and
 * gets the font checks only.
 */
export function planTextExpectations(plan, { measuredLines = {} } = {}) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const source = node.source;
    if (source && source.type === 'text' && typeof node.path === 'string' && node.path) {
      const props = source.props || {};
      const family = props.font == null ? null : String(props.font).trim() || null;
      const lines = finite(measuredLines[node.path]);
      out.push(Object.freeze({
        path: node.path,
        family,
        style: family ? requestedStyle(props) : null,
        size: finite(props.size),
        width: node.sizing?.width ?? props.w ?? null,
        lines: lines !== null && lines >= 1 ? Math.round(lines) : null,
      }));
    }
    for (const child of node.children || []) walk(child);
  };
  walk(plan?.root);
  return Object.freeze(out);
}

function validProbeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.path !== 'string' || record.path.length > MAX_PATH_CODE_UNITS) return false;
  if (record.family !== null && (typeof record.family !== 'string' || record.family.length > MAX_FAMILY_CODE_UNITS)) return false;
  if (record.style !== null && (typeof record.style !== 'string' || record.style.length > MAX_FAMILY_CODE_UNITS)) return false;
  if (record.size !== null && !(Number.isFinite(record.size) && record.size > 0)) return false;
  return Number.isFinite(record.width) && Number.isFinite(record.height) && record.width >= 0 && record.height >= 0;
}

function lineHeightPx(record) {
  const size = record.size;
  const lineHeight = record.lineHeight;
  if (lineHeight && typeof lineHeight === 'object') {
    if (lineHeight.unit === 'PIXELS' && Number.isFinite(lineHeight.value)) return lineHeight.value;
    if (lineHeight.unit === 'PERCENT' && Number.isFinite(lineHeight.value) && size) return size * lineHeight.value / 100;
  }
  // AUTO: Figma uses the font's own line gap; 1.2 is the browser's `normal`
  // approximation and only decides a rounded line count.
  return size ? size * 1.2 : null;
}

/** Compare the plan's expectations with the probe. Throws on an invalid probe. */
export function evaluateTextFidelity(expectations, probe) {
  if (!Array.isArray(probe) || probe.length > MAX_TEXT_FIDELITY_NODES || !probe.every(validProbeRecord)) {
    throw new Error('Text fidelity probe returned an invalid bounded result');
  }
  const byPath = new Map();
  for (const record of probe) if (record.path && !byPath.has(record.path)) byPath.set(record.path, record);
  const findings = [];
  let matched = 0;
  for (const expected of expectations) {
    const actual = byPath.get(expected.path);
    if (!actual) continue;
    matched++;
    if (expected.family && actual.family && expected.family.toLowerCase() !== actual.family.toLowerCase()) {
      findings.push(Object.freeze({
        kind: 'font-fallback', path: expected.path,
        expected: `${expected.family} ${expected.style}`, actual: `${actual.family} ${actual.style ?? ''}`.trim(),
      }));
    } else if (expected.family && expected.style && actual.style
      && normalizedStyle(expected.style) !== normalizedStyle(actual.style)) {
      findings.push(Object.freeze({
        kind: 'font-style-fallback', path: expected.path,
        expected: `${expected.family} ${expected.style}`, actual: `${actual.family ?? expected.family} ${actual.style}`,
      }));
    }
    if (expected.lines !== null && actual.size) {
      const perLine = lineHeightPx(actual);
      const figmaLines = expected.lines === 1
        ? (actual.height > actual.size * SINGLE_LINE_HEIGHT_FACTOR ? Math.max(2, Math.round(actual.height / perLine)) : 1)
        : Math.max(1, Math.round(actual.height / perLine));
      if (figmaLines !== expected.lines) {
        findings.push(Object.freeze({
          kind: 'line-count', path: expected.path,
          expected: `${expected.lines} line(s) in the browser`,
          actual: `${figmaLines} line(s) in Figma (${Math.round(actual.width)}×${Math.round(actual.height)} at ${actual.size}px)`,
        }));
      }
    }
  }
  return Object.freeze({
    checked: expectations.length,
    matched,
    unmatched: expectations.length - matched,
    findings: Object.freeze(findings),
  });
}

export function formatTextFidelityFinding(finding) {
  const what = finding.kind === 'line-count' ? 'wrapped differently'
    : finding.kind === 'font-style-fallback' ? 'font style fell back' : 'font fell back';
  return `${finding.path}: ${what} — expected ${finding.expected}, got ${finding.actual}`;
}

export function formatTextFidelity(report) {
  const head = `text fidelity: ${report.matched}/${report.checked} text(s) measured`
    + `${report.unmatched ? `, ${report.unmatched} not found by path` : ''}`
    + `, ${report.findings.length} finding(s)`;
  return [head, ...report.findings.map((finding) => `  ${formatTextFidelityFinding(finding)}`)].join('\n');
}
