// Repository-first Component Spec digest and bounded optional Figma conformance read.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { checkConformance, findComponentSpec, formatReuseDigest } from '../lib/design-spec.js';
import { locateDesignMd } from '../lib/design-md-locate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  componentSpecArgvFromRequest,
  componentSpecPlanningArgvFromRequest,
  parseComponentSpecRequest,
} from './component-spec-request.js';

export { componentSpecArgvFromRequest, componentSpecPlanningArgvFromRequest } from './component-spec-request.js';

const APPLICATION_ID = 'spec';
const PREPARED = new WeakSet();
export const MAX_COMPONENT_SPEC_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_COMPONENT_SPEC_RESULT_CODE_UNITS = 512 * 1024;
const MAX_MEASURED_NODES = 4_096;
const MAX_MEASURED_CHILDREN = 512;
const MAX_MEASURED_VARIANTS = 2_048;
const MAX_MEASURED_PROPERTIES = 256;
const MAX_TEXT = 1_024;
const MAX_DIMENSION = 100_000_000;

export function componentSpecPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Spec routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-component-spec';
}

function boundedOutput(value) {
  if (typeof value !== 'string' || value.length > MAX_COMPONENT_SPEC_RESULT_CODE_UNITS) {
    throw new Error('Component Spec output exceeded its bounded response limit.');
  }
  return value;
}

export function prepareComponentSpecPlan(plan, { workspaceIO } = {}) {
  if (componentSpecPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Spec.`);
  }
  if (!workspaceIO || typeof workspaceIO.readText !== 'function' || !workspaceIO.roots?.[0]) {
    throw new TypeError('Component Spec requires an authorized WorkspaceIO capability.');
  }
  const request = parseComponentSpecRequest(plan.argv);
  const file = locateDesignMd(request.file, workspaceIO.roots[0], workspaceIO);
  if (!file) {
    throw new Error('No DESIGN.md found. Pass --file <path> or run from a folder that has one (try figma_run ["extract"] first).');
  }
  const markdown = workspaceIO.readText(file, {
    role: 'design-spec-file', maxBytes: MAX_COMPONENT_SPEC_FILE_BYTES,
  });
  const spec = findComponentSpec(markdown, request.component);
  if (!spec) throw new Error(`No component matching "${request.component}" in ${file}.`);
  boundedOutput(JSON.stringify({ spec }));
  const prepared = Object.freeze({ request, file, spec });
  PREPARED.add(prepared);
  return prepared;
}

const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function componentSpecMeasureCode(request, sampleName = '') {
  const input = parseComponentSpecRequest(componentSpecArgvFromRequest(request));
  if (!input.checkNodeId) throw new Error('Component Spec measurement requires --check.');
  if (typeof sampleName !== 'string' || sampleName.length > MAX_TEXT) {
    throw new TypeError('Component Spec sample name must be bounded text.');
  }
  return `(async () => {
    const request = ${js(input)};
    const clean = (value) => typeof value === 'string' ? value.slice(0, ${MAX_TEXT}).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const dimension = (value) => Number.isFinite(value) && value >= 0 && value <= ${MAX_DIMENSION} ? Math.round(value) : 0;
    const bounded = (value) => { const serialized = JSON.stringify(value); if (serialized.length > ${MAX_COMPONENT_SPEC_RESULT_CODE_UNITS}) throw new Error('Component Spec measurement exceeded its bounded response limit.'); return serialized; };
    let count = 0;
    const tree = (node, depth) => {
      if (!node || typeof node !== 'object' || ++count > ${MAX_MEASURED_NODES}) throw new Error('Component Spec measurement exceeded its bounded node count.');
      const out = { name: clean(node.name), type: clean(node.type), w: dimension(node.width), h: dimension(node.height) };
      if ('layoutMode' in node && node.layoutMode !== 'NONE') {
        out.lm = clean(node.layoutMode); out.gap = dimension(node.itemSpacing);
        out.pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(dimension);
      }
      if (depth > 0 && 'children' in node && Array.isArray(node.children) && node.children.length) {
        if (node.children.length > ${MAX_MEASURED_CHILDREN}) throw new Error('Component Spec measurement exceeded its bounded child count.');
        out.children = node.children.map((child) => tree(child, depth - 1));
      }
      return out;
    };
    if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
    const node = await figma.getNodeByIdAsync(request.checkNodeId);
    if (!node) return bounded({ error: 'node not found' });
    const out = { id: clean(node.id), type: clean(node.type), name: clean(node.name), variants: [] };
    if (node.type === 'COMPONENT_SET') {
      if (!Array.isArray(node.children) || node.children.length > ${MAX_MEASURED_VARIANTS}) throw new Error('Component Spec measurement exceeded its bounded variant count.');
      const properties = Object.keys(node.variantGroupProperties || {});
      if (properties.length > ${MAX_MEASURED_PROPERTIES}) throw new Error('Component Spec measurement exceeded its bounded property count.');
      out.variantProps = properties.map(clean);
      out.variants = node.children.map((child) => ({ name: clean(child.name), w: dimension(child.width), h: dimension(child.height) }));
      const want = ${js(sampleName)};
      const norm = (value) => String(value).replace(/\\s+/g, '').toLowerCase().split(',').sort().join(',');
      const match = want ? node.children.find((child) => norm(child.name) === norm(want)) : node.children[0];
      if (match) out.sampleTree = tree(match, 6);
    } else {
      out.variants = [{ name: clean(node.name), w: dimension(node.width), h: dimension(node.height) }];
      out.sampleTree = tree(node, 6);
    }
    return bounded(out);
  })()`;
}

function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
const text = (value, empty = true) => typeof value === 'string' && value.length <= MAX_TEXT && (empty || value.length > 0);
const dimension = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIMENSION;
function validTree(root) {
  const stack = [{ value: root, depth: 0 }]; let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++count > MAX_MEASURED_NODES || depth > 6
      || !exact(value, ['name', 'type', 'w', 'h'], ['lm', 'gap', 'pad', 'children'])
      || !text(value.name) || !text(value.type, false) || !dimension(value.w) || !dimension(value.h)) return false;
    const hasLayout = Object.hasOwn(value, 'lm') || Object.hasOwn(value, 'gap') || Object.hasOwn(value, 'pad');
    if (hasLayout && (!text(value.lm, false) || !dimension(value.gap)
      || !Array.isArray(value.pad) || value.pad.length !== 4 || !value.pad.every(dimension))) return false;
    if (Object.hasOwn(value, 'children')) {
      if (!Array.isArray(value.children) || !value.children.length
        || value.children.length > MAX_MEASURED_CHILDREN || depth >= 6) return false;
      for (const child of value.children) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}
function validMeasured(value, request) {
  if (exact(value, ['error'])) return value.error === 'node not found';
  if (!exact(value, ['id', 'type', 'name', 'variants'], ['variantProps', 'sampleTree'])
    || value.id !== request.checkNodeId || !NODE_REFERENCE_PATTERN.test(value.id)
    || !text(value.type, false) || !text(value.name)
    || !Array.isArray(value.variants) || value.variants.length < 1
    || value.variants.length > MAX_MEASURED_VARIANTS
    || !value.variants.every((variant) => exact(variant, ['name', 'w', 'h'])
      && text(variant.name) && dimension(variant.w) && dimension(variant.h))) return false;
  if (Object.hasOwn(value, 'variantProps') && (!Array.isArray(value.variantProps)
    || value.variantProps.length > MAX_MEASURED_PROPERTIES
    || !value.variantProps.every((property) => text(property, false)))) return false;
  return !Object.hasOwn(value, 'sampleTree') || validTree(value.sampleTree);
}

function digest(spec) {
  const lines = [`${spec.name}  (${spec.variants} variants${spec.page ? ` · ${spec.page}` : ''})`];
  const reuse = formatReuseDigest(spec); if (reuse.length) lines.push(...reuse);
  const axes = Object.entries(spec.axes).map(([key, values]) => `  ${key}: ${values.join(', ')}`);
  if (axes.length) lines.push('axes:', ...axes);
  if (spec.sample) {
    const sample = spec.sample;
    const meta = [sample.lm === 'HORIZONTAL' ? 'row' : sample.lm === 'VERTICAL' ? 'col' : null,
      sample.gap != null ? `gap ${sample.gap}` : null,
      sample.pad ? `pad ${sample.pad.join('/')}` : null,
      sample.children?.length ? `${sample.children.length} children` : null].filter(Boolean).join(', ');
    lines.push(`sample: ${sample.name} → ${sample.w}×${sample.h}${meta ? ` (${meta})` : ''}`);
  }
  lines.push('', `build to this, then enforce: figma_run ["spec","${spec.name}","--check","<nodeId>"]`, JSON.stringify({ spec }));
  return boundedOutput(lines.join('\n'));
}

function conformanceOutput(spec, nodeId, conformance) {
  const lines = [`Conformance: ${spec.name} vs ${nodeId}`];
  for (const rule of conformance.rules) lines.push(`  ${rule.ok ? '✓' : rule.warn ? '⚠' : '✗'} ${rule.msg}`);
  if (!conformance.rules.length) lines.push('  (no enforceable rules for this component)');
  const warnings = conformance.rules.filter((rule) => !rule.ok && rule.warn).length;
  if (!conformance.pass) lines.push('', '✗ Build does NOT conform to the DESIGN.md spec.');
  else lines.push('', `✓ Conforms to spec.${warnings ? ` (${warnings} advisory hint${warnings > 1 ? 's' : ''})` : ''}`);
  return boundedOutput(lines.join('\n'));
}

export async function executeComponentSpec(prepared, adapters = {}) {
  if (!PREPARED.has(prepared)) throw new TypeError('Component Spec requires its authentic prepared source.');
  if (!prepared.request.checkNodeId) {
    return { stdout: digest(prepared.spec), stderr: '', code: 0, result: { spec: prepared.spec } };
  }
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Component Spec check requires a Figma evaluate adapter.');
  const serialized = await adapters.evaluate(componentSpecMeasureCode(
    prepared.request, prepared.spec.sample?.name || '',
  ));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_SPEC_RESULT_CODE_UNITS) {
    throw new Error('Component Spec returned an invalid bounded measurement.');
  }
  let measured; try { measured = JSON.parse(serialized); } catch { throw new Error('Component Spec returned invalid measurement JSON.'); }
  if (!validMeasured(measured, prepared.request)) throw new Error('Component Spec returned an invalid bounded measurement.');
  if (measured.error) throw new Error(`Could not measure node: ${measured.error}`);
  const conformance = checkConformance(prepared.spec, measured, { tolerance: prepared.request.tolerance });
  return {
    stdout: conformanceOutput(prepared.spec, prepared.request.checkNodeId, conformance),
    stderr: prepared.request.warning ? `⚠ ${prepared.request.warning}` : '',
    code: conformance.pass ? 0 : 1,
    result: { pass: conformance.pass, rules: conformance.rules },
  };
}

export async function executeComponentSpecPlan(plan, prepared, adapters = {}) {
  if (componentSpecPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Spec.`);
  }
  const request = parseComponentSpecRequest(plan.argv);
  if (!PREPARED.has(prepared) || !isDeepStrictEqual(prepared.request, request)) {
    throw new TypeError('Component Spec requires its authentic prepared source.');
  }
  return executeComponentSpec(prepared, adapters);
}
