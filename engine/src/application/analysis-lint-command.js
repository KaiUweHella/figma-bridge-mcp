// Exact bounded design-system lint read for one subtree or the current page.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { GENERIC_NAME_PATTERNS } from '../lib/eval-snippets.js';
import {
  ANALYSIS_LINT_KINDS,
  analysisLintArgvFromRequest,
  analysisLintPlanningArgvFromRequest,
  parseAnalysisLintRequest,
} from './analysis-lint-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  analysisLintArgvFromRequest,
  analysisLintPlanningArgvFromRequest,
} from './analysis-lint-request.js';

const APPLICATION_ID = 'analyze.lint';
export const MAX_ANALYSIS_LINT_NODES = 100_000;
export const MAX_ANALYSIS_LINT_FACTS = 400_000;
export const MAX_ANALYSIS_LINT_ISSUES = 4096;
export const MAX_ANALYSIS_LINT_RESOURCES = 100_000;
export const MAX_ANALYSIS_LINT_RESULT_CODE_UNITS = 1_000_000;
const MAX_PAINTS_PER_FIELD = 4096;
const MAX_MODES_PER_VARIABLE = 1024;
const MAX_LABEL_CODE_UNITS = 1024;
const MAX_DETAIL_CODE_UNITS = 4096;
const MAX_RESOURCE_ID_CODE_UNITS = 512;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const UNSAFE_TEXT_CONTROLS_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const LINT_META = Object.freeze({
  bindable: Object.freeze({ label: 'unbound token colour' }),
  naming: Object.freeze({ label: 'default layer name' }),
  typography: Object.freeze({ label: 'text without a style' }),
  legibility: Object.freeze({ label: 'text under 12px' }),
});

const normalized = (request) => parseAnalysisLintRequest(analysisLintArgvFromRequest(request));

/** Build the bounded lint eval. Pure; retained as a compatibility Interface for tests and embedders. */
export function lintCode({ rootId = null, generic = [...GENERIC_NAME_PATTERNS] } = {}) {
  return `(async () => {
  const MAX_NODES = ${MAX_ANALYSIS_LINT_NODES};
  const MAX_FACTS = ${MAX_ANALYSIS_LINT_FACTS};
  const MAX_ISSUES = ${MAX_ANALYSIS_LINT_ISSUES};
  const MAX_RESOURCES = ${MAX_ANALYSIS_LINT_RESOURCES};
  const MAX_PAINTS = ${MAX_PAINTS_PER_FIELD};
  const MAX_MODES = ${MAX_MODES_PER_VARIABLE};
  const MAX_LABEL = ${MAX_LABEL_CODE_UNITS};
  const MAX_DETAIL = ${MAX_DETAIL_CODE_UNITS};
  const MAX_RESOURCE_ID = ${MAX_RESOURCE_ID_CODE_UNITS};
  const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
  const finiteUnit = (value) => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= 1;
  const clean = (value, limit, label) => {
    if (typeof value !== 'string' || value.length > limit) {
      throw new Error('Analyze lint found invalid bounded ' + label + '.');
    }
    return value.replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
  };
  const bounded = (payload) => {
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_ANALYSIS_LINT_RESULT_CODE_UNITS}) {
      throw new Error('Analyze lint result exceeded its bounded response limit.');
    }
    return serialized;
  };
  ${rootId
    ? `const root = await figma.getNodeByIdAsync(${JSON.stringify(rootId)});
       if (!root) throw new Error('Node not found in the targeted Figma document: ${rootId}');
       const roots = [root];`
    : `if (!figma.currentPage || !Array.isArray(figma.currentPage.children)) {
         throw new Error('Analyze lint requires one available current page.');
       }
       const roots = figma.currentPage.children.slice();`}
  if (roots.length > MAX_NODES) throw new Error('Analyze lint node limit exceeded.');

  if (!figma.variables
    || typeof figma.variables.getLocalVariableCollectionsAsync !== 'function'
    || typeof figma.variables.getLocalVariablesAsync !== 'function') {
    throw new Error('Analyze lint requires the local Variable APIs.');
  }
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();
  if (!Array.isArray(collections) || collections.length > MAX_RESOURCES
    || !Array.isArray(allVars) || allVars.length > MAX_RESOURCES) {
    throw new Error('Analyze lint local resource limit exceeded.');
  }
  const collectionNames = new Map();
  for (const collection of collections) {
    if (!collection || typeof collection.id !== 'string' || !collection.id
      || collection.id.length > MAX_RESOURCE_ID) {
      throw new Error('Analyze lint found invalid Collection facts.');
    }
    const name = clean(collection.name, MAX_LABEL, 'Collection name');
    if (!collectionNames.has(collection.id)) collectionNames.set(collection.id, name);
  }
  const colName = (v) => collectionNames.get(v.variableCollectionId) || '(unknown)';

  // value → variable, for COLOR variables only. Keyed on the rounded RGB of
  // each mode's value, so a token defined per-theme is matched in any of them.
  const byColor = new Map();
  const key = (c) => [c.r, c.g, c.b].map(n => Math.round(n * 255)).join(',');
  let facts = 0;
  const addFact = () => {
    facts += 1;
    if (facts > MAX_FACTS) throw new Error('Analyze lint fact limit exceeded.');
  };
  for (const v of allVars) {
    if (!v || typeof v.id !== 'string' || !v.id || v.id.length > MAX_RESOURCE_ID
      || typeof v.variableCollectionId !== 'string'
      || v.variableCollectionId.length > MAX_RESOURCE_ID
      || typeof v.resolvedType !== 'string' || v.resolvedType.length > 64) {
      throw new Error('Analyze lint found invalid Variable facts.');
    }
    const variableName = clean(v.name, MAX_LABEL, 'Variable name');
    if (v.resolvedType !== 'COLOR') continue;
    if (!v.valuesByMode || typeof v.valuesByMode !== 'object'
      || Array.isArray(v.valuesByMode)) {
      throw new Error('Analyze lint found invalid Variable mode facts.');
    }
    const values = Object.values(v.valuesByMode);
    if (values.length > MAX_MODES) throw new Error('Analyze lint Variable mode limit exceeded.');
    for (const val of values) {
      addFact();
      if (!val || typeof val !== 'object' || typeof val.r !== 'number') continue; // skip aliases
      if (!finiteUnit(val.r) || !finiteUnit(val.g) || !finiteUnit(val.b)) {
        throw new Error('Analyze lint found an invalid Variable colour.');
      }
      const k = key(val);
      if (!byColor.has(k)) byColor.set(k, {
        id: v.id, name: variableName, variableCollectionId: v.variableCollectionId,
      });
    }
  }

  const GENERIC = new Set(${JSON.stringify(generic)});
  const issues = [];
  const seen = new Set();
  const addIssue = (issue) => {
    if (issues.length >= MAX_ISSUES) throw new Error('Analyze lint issue limit exceeded.');
    issues.push(issue);
  };
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n || typeof n.id !== 'string' || !nodeIdPattern.test(n.id)
      || n.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}) {
      throw new Error('Analyze lint found invalid node identity facts.');
    }
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (seen.size > MAX_NODES) throw new Error('Analyze lint node limit exceeded.');
    const name = clean(n.name, MAX_LABEL, 'node name');
    const type = clean(n.type, 64, 'node type');
    if (!type) throw new Error('Analyze lint found an empty node type.');

    // A literal type name, alone or with Figma's auto-numbering ("Frame 12").
    // NOT a prefix test: "Frame Header" is a deliberate name.
    const bare = String(name).trim().replace(/\\s+\\d+$/, '').toLowerCase();
    if (GENERIC.has(bare)) {
      addIssue({ kind: 'naming', id: n.id, name, type,
                 detail: 'still carries its default layer name' });
    }

    for (const [prop, field] of [['fill', 'fills'], ['stroke', 'strokes']]) {
      const paints = n[field];
      if (!Array.isArray(paints)) continue;
      if (paints.length > MAX_PAINTS) throw new Error('Analyze lint paint limit exceeded.');
      for (const p of paints) {
        addFact();
        if (!p || p.type !== 'SOLID' || p.visible === false) continue;
        if (p.boundVariables && p.boundVariables.color) continue;   // already bound
        if (!p.color || !finiteUnit(p.color.r) || !finiteUnit(p.color.g)
          || !finiteUnit(p.color.b)) {
          throw new Error('Analyze lint found an invalid solid colour.');
        }
        const match = byColor.get(key(p.color));
        if (!match) continue;                                        // not a token colour — nothing to say
        const detail = prop + ' is #' + [p.color.r, p.color.g, p.color.b]
          .map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
          + ', which is ' + match.name;
        const fix = 'node bind ' + n.id + ' ' + prop + ' ' + JSON.stringify(match.name)
          + ' --collection ' + JSON.stringify(colName(match));
        if (detail.length > MAX_DETAIL || fix.length > MAX_DETAIL) {
          throw new Error('Analyze lint issue detail limit exceeded.');
        }
        addIssue({ kind: 'bindable', id: n.id, name, type, detail, fix });
      }
    }

    if (n.type === 'TEXT') {
      if (!n.textStyleId) {
        addIssue({ kind: 'typography', id: n.id, name, type,
                   detail: 'no text style — its typography is loose' });
      }
      const size = typeof n.fontSize === 'number' ? n.fontSize : null;
      if (size !== null) {
        if (!Number.isFinite(size)) throw new Error('Analyze lint found an invalid font size.');
        if (size < 12) {
          const detail = size + 'px is below the 12px readability floor';
          if (detail.length > MAX_DETAIL) throw new Error('Analyze lint issue detail limit exceeded.');
          addIssue({ kind: 'legibility', id: n.id, name, type, detail });
        }
      }
    }

    const children = 'children' in n ? n.children : null;
    if (children !== null && !Array.isArray(children)) {
      throw new Error('Analyze lint found invalid child facts.');
    }
    if (children) {
      if (children.length > MAX_NODES) throw new Error('Analyze lint child limit exceeded.');
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
  }

  const counts = {};
  for (const issue of issues) counts[issue.kind] = (counts[issue.kind] || 0) + 1;
  return bounded({
    schemaVersion: 1,
    source: ${JSON.stringify(rootId ? 'node' : 'current-page')},
    nodeId: ${rootId ? JSON.stringify(rootId) : 'null'},
    nodesWalked: seen.size,
    total: issues.length,
    counts,
    issues,
  });
})()`;
}

export function analysisLintCode(request) {
  const input = normalized(request);
  return lintCode({ rootId: input.nodeId, generic: [...GENERIC_NAME_PATTERNS] });
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
function boundedText(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE_TEXT_CONTROLS.test(value);
}
function validIssue(value) {
  if (!value || !ANALYSIS_LINT_KINDS.includes(value.kind)) return false;
  const keys = value.kind === 'bindable'
    ? ['kind', 'id', 'name', 'type', 'detail', 'fix']
    : ['kind', 'id', 'name', 'type', 'detail'];
  return exact(value, keys)
    && boundedText(value.id, MAX_NODE_REFERENCE_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && boundedText(value.name, MAX_LABEL_CODE_UNITS)
    && boundedText(value.type, 64, false)
    && boundedText(value.detail, MAX_DETAIL_CODE_UNITS, false)
    && (value.kind !== 'bindable' || boundedText(value.fix, MAX_DETAIL_CODE_UNITS, false));
}
function validPayload(value, input) {
  if (!exact(value, [
    'schemaVersion', 'source', 'nodeId', 'nodesWalked', 'total', 'counts', 'issues',
  ]) || value.schemaVersion !== 1
    || value.source !== (input.nodeId ? 'node' : 'current-page')
    || value.nodeId !== input.nodeId
    || !Number.isSafeInteger(value.nodesWalked) || value.nodesWalked < 0
    || value.nodesWalked > MAX_ANALYSIS_LINT_NODES
    || !Number.isSafeInteger(value.total) || value.total < 0
    || value.total > MAX_ANALYSIS_LINT_ISSUES
    || !Array.isArray(value.issues) || value.issues.length !== value.total
    || !value.issues.every(validIssue)
    || !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)
    || Object.getPrototypeOf(value.counts) !== Object.prototype) return false;
  const countKeys = Object.keys(value.counts);
  if (countKeys.some((kind) => !ANALYSIS_LINT_KINDS.includes(kind)
    || !Number.isSafeInteger(value.counts[kind]) || value.counts[kind] < 1
    || value.counts[kind] > MAX_ANALYSIS_LINT_ISSUES)) return false;
  if (countKeys.reduce((total, kind) => total + value.counts[kind], 0) !== value.total) return false;
  return ANALYSIS_LINT_KINDS.every((kind) =>
    (value.counts[kind] || 0) === value.issues.filter((issue) => issue.kind === kind).length);
}

function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS_GLOBAL, ' '); }
function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatAnalysisLintResult(payload, request) {
  const wanted = payload.issues.filter((issue) => request.kinds.includes(issue.kind));
  if (request.json) {
    return safePrettyJson({
      nodesWalked: payload.nodesWalked,
      total: payload.total,
      counts: payload.counts,
      issues: wanted,
    });
  }
  if (wanted.length === 0) {
    return `✓ Nothing to fix across ${payload.nodesWalked} node(s).`;
  }
  const lines = [`${wanted.length} finding(s) across ${payload.nodesWalked} node(s):`];
  for (const kind of request.kinds) {
    const group = wanted.filter((issue) => issue.kind === kind);
    if (group.length === 0) continue;
    lines.push('', `  ${LINT_META[kind].label} — ${group.length}`);
    for (const issue of group.slice(0, request.limit)) {
      lines.push(`    ${issue.id.padEnd(10)} ${safeText(issue.name)}  ${safeText(issue.detail)}`);
      if (issue.fix) lines.push(`      fix: ${safeText(issue.fix)}`);
    }
    if (group.length > request.limit) {
      lines.push(`    … ${group.length - request.limit} more (--limit ${group.length} to see them, or --json)`);
    }
  }
  return lines.join('\n');
}

export async function executeAnalysisLint(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Analyze lint requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(analysisLintCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANALYSIS_LINT_RESULT_CODE_UNITS) {
    throw new Error('Analyze lint returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Analyze lint returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Analyze lint returned an invalid bounded result.');
  }
  const wanted = payload.issues.filter((issue) => input.kinds.includes(issue.kind));
  const result = { ...payload, issues: wanted };
  return {
    stdout: formatAnalysisLintResult(payload, input),
    stderr: input.warning || '',
    code: input.failOnIssues && wanted.length > 0 ? 1 : 0,
    result,
  };
}

export function analysisLintPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Analyze lint routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-analysis-lint';
}

export function executeAnalysisLintPlan(plan, adapters = {}) {
  if (analysisLintPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Analyze lint.');
  }
  return executeAnalysisLint(parseAnalysisLintRequest(plan.argv), adapters);
}
