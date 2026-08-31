// One Plan-bound Application for Figma-to-Storybook component mapping.

import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { fetchStorybookIndex, parseStorybookIndex } from '../code-import/storybook.js';
import { componentInventoryCode, projectComponentInventory } from '../lib/component-inventory.js';
import { matchComponents, mergeMaps } from '../lib/story-match.js';
import {
  parseStorybookMapRequest,
  storybookMapArgvFromRequest,
  storybookMapPlanningArgvFromRequest,
} from './storybook-map-request.js';

export { storybookMapArgvFromRequest, storybookMapPlanningArgvFromRequest };

const APPLICATION_ID = 'map.storybook';
const PREPARED_MAPS = new WeakSet();

function requiresWorkspace(workspaceIO, { write = false } = {}) {
  if (!workspaceIO || typeof workspaceIO.exists !== 'function'
    || typeof workspaceIO.readJson !== 'function'
    || !workspaceIO.limits
    || (write && typeof workspaceIO.write !== 'function')) {
    throw new TypeError(write
      ? 'Storybook Map requires an authorized writable WorkspaceIO capability.'
      : 'Storybook Map requires an authorized readable WorkspaceIO capability.');
  }
  return workspaceIO;
}

function prepared(value) {
  PREPARED_MAPS.add(value);
  return Object.freeze(value);
}

function safeJson(value, indentation = 2) {
  return JSON.stringify(value, null, indentation).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function mappedComponents(inventory) {
  return [
    ...inventory.componentSets.map((set) => {
      const defaultVariant = set.variants.find((variant) => variant.id === set.defaultVariantId)
        || set.variants[0];
      return {
        name: set.name,
        page: set.page,
        nodeId: set.id,
        kind: 'set',
        figmaKey: set.key,
        figmaVariantKey: defaultVariant?.key ?? null,
      };
    }),
    ...inventory.standaloneComponents.map((component) => ({
      name: component.name,
      page: component.page,
      nodeId: component.id,
      kind: 'component',
      figmaKey: component.key,
      figmaVariantKey: component.key,
    })),
  ];
}

function generatedAt(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Storybook Map clock returned an invalid timestamp.');
  return date.toISOString();
}

function humanResult(map) {
  const by = (confidence) => map.mappings.filter((item) => item.confidence === confidence).length;
  const manual = map.mappings.filter((item) => item.matchedBy === 'manual').length;
  const lines = [
    `${map.mappings.length} mapped (${by('high')} high / ${by('medium')} medium / ${by('low')} low${manual ? ` / ${manual} manual` : ''})`,
  ];
  for (const item of map.mappings) {
    const confidence = item.matchedBy === 'manual' ? 'manual' : item.confidence;
    lines.push(`  ${item.figmaName} ↔ ${item.storyTitle} (${confidence})`);
  }
  if (map.unmatchedFigma.length) {
    lines.push('', `${map.unmatchedFigma.length} Figma component(s) without a story:`);
    for (const item of map.unmatchedFigma) lines.push(`  ${item.name ?? item.figmaName} (${item.reason ?? 'no-match'})`);
  }
  if (map.unmatchedStories.length) {
    lines.push('', `${map.unmatchedStories.length} story component(s) without a Figma component:`);
    for (const item of map.unmatchedStories) lines.push(`  ${item.storyTitle}`);
  }
  lines.push('', `Written to ${map.output}. Pin entries by setting "matchedBy": "manual" — they survive re-runs.`);
  return lines.join('\n');
}

export function storybookMapPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Storybook Map routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-storybook-map';
}

export async function prepareStorybookMapPlan(plan, {
  workspaceIO,
  fetchIndex = fetchStorybookIndex,
} = {}) {
  if (storybookMapPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Storybook Map.`);
  }
  const io = requiresWorkspace(workspaceIO);
  const request = parseStorybookMapRequest(plan.argv);
  const indexText = await fetchIndex(request.source, { workspaceIO: io });
  if (typeof indexText !== 'string') {
    throw new Error('Storybook Map source reader returned a non-text index.');
  }
  const parsed = parseStorybookIndex(indexText, { limits: io.limits });
  let existing = null;
  let warning = '';
  if (io.exists(request.output, { role: 'component-map-output', kind: 'file' })) {
    try {
      existing = io.readJson(request.output, { role: 'component-map-output' });
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)
        || !Array.isArray(existing.mappings)) {
        throw new Error('map shape is invalid');
      }
    } catch {
      existing = null;
      warning = `Existing ${request.output} is not a valid component map — overwriting.`;
    }
  }
  return prepared({
    request,
    storyComponents: Object.freeze(parsed.meta.components),
    existing,
    warning,
  });
}

export async function executeStorybookMapPlan(plan, preparedMap, adapters = {}) {
  if (storybookMapPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Storybook Map.`);
  }
  const request = parseStorybookMapRequest(plan.argv);
  if (!PREPARED_MAPS.has(preparedMap)
    || !isDeepStrictEqual(preparedMap.request, request)) {
    throw new Error('Storybook Map requires its authentic prepared source.');
  }
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Storybook Map requires a Figma evaluate adapter.');
  }
  const io = requiresWorkspace(adapters.workspaceIO, { write: true });
  const inventory = projectComponentInventory(
    await adapters.evaluate(componentInventoryCode(!request.currentPage)),
  );
  const expectedScope = request.currentPage ? 'CURRENT_PAGE' : 'ALL_PAGES';
  if (inventory.scope !== expectedScope) {
    throw new Error('Storybook Map returned a mismatched component scan scope.');
  }
  const matched = mergeMaps(
    preparedMap.existing,
    matchComponents(mappedComponents(inventory), preparedMap.storyComponents),
  );
  const map = {
    version: 1,
    generatedAt: generatedAt(adapters.now),
    figmaFile: inventory.fileName || null,
    storybookSource: request.source,
    mappings: matched.mappings,
    unmatchedFigma: matched.unmatchedFigma.map(({
      name, page, figmaKey, nodeId, reason,
    }) => ({
      figmaName: name,
      figmaPage: page,
      figmaKey: figmaKey ?? null,
      figmaNodeId: nodeId,
      reason,
    })),
    unmatchedStories: matched.unmatchedStories,
  };
  const serialized = `${safeJson(map)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > io.limits.jsonBytes) {
    throw new Error(`Storybook Map output exceeds the Workspace JSON limit of ${io.limits.jsonBytes} bytes.`);
  }
  io.write(request.output, serialized, {
    role: 'component-map-output',
    createParents: true,
  });
  const result = { ...map, output: request.output };
  return {
    stdout: request.json ? safeJson(map) : humanResult(result),
    stderr: preparedMap.warning,
    code: 0,
    result,
  };
}
