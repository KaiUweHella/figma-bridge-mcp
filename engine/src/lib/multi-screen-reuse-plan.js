// Content-free component reuse acceptance for compound Semantic Render.
//
// The plan is derived before Plugin readiness. It records explicit Design
// Entity instances and hashes repeated raw structure so an approval is tied to
// one current finding instead of becoming a broad component-first bypass.

import { createHash } from 'node:crypto';
import { repeatSignature } from './render-lint.js';

const FLAT_ID = /^flat-[0-9a-f]{12}$/;
const MAX_FINDINGS = 100;
const MAX_COMPONENTS = 100;

function preflightError(message) {
  return Object.assign(new Error(`Multi-screen reuse preflight failed: ${message}`), {
    kind: 'validation',
    phase: 'request-validation',
    outcome: 'not-dispatched',
  });
}

function parseRoot(client, jsx) {
  const source = String(jsx);
  const open = /<Frame\b([^>]*)>/.exec(source);
  if (!open) throw preflightError('every screen root must be a Frame');
  const props = client.parseProps(open[1].replace(/\/$/, ''));
  const selfClosing = /\/\s*>$/.test(open[0]);
  const children = selfClosing
    ? []
    : client.parseChildren(client.extractContent(source.slice(open.index + open[0].length), 'Frame'));
  return { _type: 'frame', ...props, _children: children };
}

function freezeArray(values) {
  return Object.freeze(values.map((value) => Object.freeze(value)));
}

function structureInventory(client, roots) {
  const structures = new Map();
  const componentUses = new Map();
  const visit = (item, rootIndex, path, depth) => {
    if (!item || typeof item !== 'object') return;
    if (item._type === 'instance' && typeof item.entity === 'string') {
      const entity = item.entity;
      const use = componentUses.get(entity) || { entity, instances: 0, roots: new Set() };
      use.instances++;
      use.roots.add(rootIndex);
      componentUses.set(entity, use);
    }
    if (item._type === 'frame' && depth > 0) {
      const signature = repeatSignature(item);
      if (signature.length >= 30) {
        const entry = structures.get(signature) || { signature, occurrences: [] };
        entry.occurrences.push({ rootIndex, path, depth });
        structures.set(signature, entry);
      }
    }
    for (let index = 0; index < (item._children || []).length; index++) {
      visit(item._children[index], rootIndex, `${path}.children[${index}]`, depth + 1);
    }
  };
  roots.forEach((jsx, rootIndex) => visit(parseRoot(client, jsx), rootIndex, `root[${rootIndex}]`, 0));
  return { structures, componentUses };
}

function isBelowSelected(occurrence, selected) {
  return selected.some((finding) => finding.occurrences.some((parent) =>
    parent.rootIndex === occurrence.rootIndex
    && occurrence.path.startsWith(`${parent.path}.children[`)));
}

function repeatedStructures(structures, rootCount) {
  if (rootCount < 2) return [];
  const candidates = [];
  for (const entry of structures.values()) {
    const roots = new Set(entry.occurrences.map((item) => item.rootIndex));
    if (entry.occurrences.length >= 3 || (entry.occurrences.length >= 2 && roots.size >= 2)) {
      candidates.push({ ...entry, roots, depth: Math.min(...entry.occurrences.map((item) => item.depth)) });
    }
  }
  candidates.sort((left, right) => left.depth - right.depth
    || left.signature.localeCompare(right.signature));
  const selected = [];
  for (const candidate of candidates) {
    if (candidate.occurrences.every((occurrence) => isBelowSelected(occurrence, selected))) continue;
    selected.push(candidate);
    if (selected.length >= MAX_FINDINGS) break;
  }
  return selected;
}

export function buildMultiScreenReusePlan(client, roots, {
  approvedFlatRepetitions = [],
  direction = 'row',
  placement = { smart: true, x: null, y: null },
} = {}) {
  if (!client || typeof client.parseChildren !== 'function' || typeof client.parseProps !== 'function') {
    throw new TypeError('Multi-screen reuse planning requires the Semantic JSX parser.');
  }
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 100) {
    throw new TypeError('Multi-screen reuse planning requires 1 to 100 roots.');
  }
  if (!Array.isArray(approvedFlatRepetitions)
    || approvedFlatRepetitions.some((id) => typeof id !== 'string' || !FLAT_ID.test(id))) {
    throw preflightError('flat repetition approvals must use exact flat-xxxxxxxxxxxx finding ids');
  }
  const approved = new Set(approvedFlatRepetitions);
  const { structures, componentUses } = structureInventory(client, roots);
  const selected = repeatedStructures(structures, roots.length);
  const flatRepetitions = selected.map((entry) => {
    const id = `flat-${createHash('sha256').update(entry.signature).digest('hex').slice(0, 12)}`;
    return {
      id,
      count: entry.occurrences.length,
      rootIndexes: Object.freeze([...entry.roots].sort((left, right) => left - right)),
      approved: approved.has(id),
      occurrences: entry.occurrences,
    };
  });
  const currentIds = new Set(flatRepetitions.map((finding) => finding.id));
  const stale = [...approved].filter((id) => !currentIds.has(id));
  if (stale.length) {
    throw preflightError(`approval ${stale[0]} does not match a current flat repetition`);
  }
  const components = [...componentUses.values()]
    .sort((left, right) => left.entity.localeCompare(right.entity))
    .slice(0, MAX_COMPONENTS)
    .map((use) => ({
      entity: use.entity,
      instances: use.instances,
      rootIndexes: Object.freeze([...use.roots].sort((left, right) => left - right)),
      firstRoot: Math.min(...use.roots),
    }));
  const publicFindings = flatRepetitions.map(({ occurrences: _occurrences, ...finding }) => finding);
  return Object.freeze({
    version: 1,
    rootCount: roots.length,
    placement: Object.freeze({
      direction,
      startsRightOfOccupiedCanvas: direction === 'row' && placement.smart !== false
        && placement.x == null,
      explicitVertical: direction === 'col',
    }),
    components: freezeArray(components),
    flatRepetitions: freezeArray(publicFindings),
    summary: Object.freeze({
      reusedComponents: components.length,
      reusedInstances: components.reduce((sum, item) => sum + item.instances, 0),
      approvedFlatRepetitions: publicFindings.filter((finding) => finding.approved).length,
    }),
  });
}

export function assertMultiScreenReuseAcceptance(plan) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.flatRepetitions)) {
    throw new TypeError('Multi-screen reuse acceptance requires a prepared reuse plan.');
  }
  const finding = plan.flatRepetitions.find((entry) => !entry.approved);
  if (finding) {
    const roots = finding.rootIndexes.map((index) => index + 1).join(', ');
    throw preflightError(
      `${finding.id} identifies ${finding.count} repeated raw structures across root(s) ${roots}; `
      + 'create or link one component Design Entity and replace the copies with <Instance entity="ui.component" />, '
      + `or review only this repetition and rerun with --approve-flat-repetition=${finding.id}`,
    );
  }
  return plan;
}

export function completeMultiScreenReuseReport(plan, { createdComponents = 0 } = {}) {
  assertMultiScreenReuseAcceptance(plan);
  if (!Number.isSafeInteger(createdComponents) || createdComponents < 0 || createdComponents > 100) {
    throw new TypeError('Multi-screen reuse completion received an invalid created component count.');
  }
  return Object.freeze({
    version: 1,
    rootCount: plan.rootCount,
    placement: plan.placement,
    components: plan.components,
    flatRepetitions: plan.flatRepetitions,
    summary: Object.freeze({
      ...plan.summary,
      createdComponents,
    }),
  });
}
