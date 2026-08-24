// Value-returning Page Structure Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  pageStructureArgvFromRequest,
  pageStructurePlanningArgvFromRequest,
  parsePageStructureRequest,
} from './page-structure-request.js';

export {
  pageStructureArgvFromRequest,
  pageStructurePlanningArgvFromRequest,
} from './page-structure-request.js';

const APPLICATION_IDS = new Set(['canvas.page-create', 'canvas.page-divider']);
const MAX_ROOT_ENTRIES = 4096;
const MAX_PAGE_ID_CODE_UNITS = 256;
const MAX_PAGE_NAME_CODE_UNITS = 4096;
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function invalidResult() {
  throw new Error('Figma returned an invalid Page Structure result.');
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maximum, { empty = false } = {}) {
  return typeof value === 'string'
    && (empty || value.length > 0)
    && value.length <= maximum;
}

function safeDisplay(value) {
  return String(value).replace(UNSAFE_DISPLAY, '�');
}

function pageIdentity(value) {
  if (!record(value)
    || !boundedString(value.id, MAX_PAGE_ID_CODE_UNITS)
    || !boundedString(value.name, MAX_PAGE_NAME_CODE_UNITS, { empty: true })) invalidResult();
  return { id: value.id, name: value.name };
}

function cleanupResult(value) {
  if (!record(value) || value.status !== 'mutation-failed'
    || !['removed', 'partial-residue'].includes(value.cleanup)) invalidResult();
  return value.cleanup;
}

function createdPageResult(value, input) {
  if (!record(value) || value.status !== 'created' || typeof value.switched !== 'boolean') invalidResult();
  const page = pageIdentity(value);
  if (page.name !== input.name || value.switched !== input.switchPage) invalidResult();
  return { ...page, switched: value.switched };
}

function createdDividerResult(value, input) {
  if (!record(value) || value.status !== 'created'
    || value.isPageDivider !== true
    || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > MAX_ROOT_ENTRIES) {
    invalidResult();
  }
  const divider = pageIdentity(value);
  if ((input.name !== null && divider.name !== input.name)
    || (input.index !== null && value.index !== input.index)) invalidResult();
  return { ...divider, index: value.index, isPageDivider: true };
}

function pageCreateCode({ name, switchPage }) {
  return `(async () => {
const name = ${JSON.stringify(name)};
const existing = figma.root.children.find((entry) => entry.name === name);
if (existing) return { status: 'duplicate', id: existing.id, name: existing.name };
const page = figma.createPage();
try {
  page.name = name;
  ${switchPage ? 'await figma.setCurrentPageAsync(page);' : ''}
  return { status: 'created', id: page.id, name: page.name, switched: ${switchPage} };
} catch {
  let cleanup = 'removed';
  try { page.remove(); } catch { cleanup = 'partial-residue'; }
  return { status: 'mutation-failed', cleanup };
}
})()`;
}

function pageDividerCode({ name, index }) {
  const create = name === null
    ? 'figma.createPageDivider()'
    : `figma.createPageDivider(${JSON.stringify(name)})`;
  return `(async () => {
const requestedIndex = ${index === null ? 'null' : JSON.stringify(index)};
const rootCount = figma.root.children.length;
if (rootCount > ${MAX_ROOT_ENTRIES}) return { status: 'root-too-large' };
if (requestedIndex !== null && requestedIndex > rootCount) {
  return { status: 'index-out-of-range', maximum: rootCount };
}
const divider = ${create};
try {
  if (requestedIndex !== null) figma.root.insertChild(requestedIndex, divider);
  return {
    status: 'created', id: divider.id, name: divider.name,
    index: figma.root.children.indexOf(divider), isPageDivider: divider.isPageDivider,
  };
} catch {
  let cleanup = 'removed';
  try { divider.remove(); } catch { cleanup = 'partial-residue'; }
  return { status: 'mutation-failed', cleanup };
}
})()`;
}

function normalizedRequest(request) {
  return parsePageStructureRequest(pageStructureArgvFromRequest(request));
}

function mutationFailure(kind, cleanup) {
  const noun = kind === 'page-create' ? 'page' : 'page divider';
  throw new Error(cleanup === 'removed'
    ? `Page Structure failed after creation; the created ${noun} was removed.`
    : `Page Structure failed after creation; the created ${noun} may remain.`);
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executePageStructure(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executePageStructure requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const raw = await adapters.evaluate(input.action === 'page-create'
    ? pageCreateCode(input)
    : pageDividerCode(input));

  if (raw?.status === 'mutation-failed') mutationFailure(input.action, cleanupResult(raw));
  if (input.action === 'page-create') {
    if (raw?.status === 'duplicate') {
      const existing = pageIdentity(raw);
      throw new Error(`Page already exists: ${safeDisplay(existing.name)} (${safeDisplay(existing.id)})`);
    }
    const result = createdPageResult(raw, input);
    return {
      stdout: `✓ Created page: ${safeDisplay(result.name)} (${safeDisplay(result.id)})${result.switched ? ' — now current' : ''}`,
      stderr: '',
      result,
    };
  }

  if (raw?.status === 'root-too-large') {
    throw new Error(`Page Structure supports at most ${MAX_ROOT_ENTRIES} existing document entries.`);
  }
  if (raw?.status === 'index-out-of-range') {
    if (!Number.isSafeInteger(raw.maximum) || raw.maximum < 0 || raw.maximum > MAX_ROOT_ENTRIES) {
      invalidResult();
    }
    throw new Error(`Index out of range: ${input.index} (maximum ${raw.maximum})`);
  }
  const result = createdDividerResult(raw, input);
  return {
    stdout: input.json
      ? JSON.stringify(result, null, 2)
      : `✓ Created page divider (${safeDisplay(result.id)})`,
    stderr: '',
    result,
  };
}

export function pageStructurePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Page Structure routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application'
    : 'not-page-structure';
}

export async function executePageStructurePlan(plan, adapters = {}) {
  if (pageStructurePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Page Structure Command Application.`);
  }
  return executePageStructure(parsePageStructureRequest(plan.argv), adapters);
}
