// Value-returning Page Navigation Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  pageNavigationArgvFromRequest,
  pageNavigationPlanningArgvFromRequest,
  parsePageNavigationRequest,
} from './page-navigation-request.js';

export {
  pageNavigationArgvFromRequest,
  pageNavigationPlanningArgvFromRequest,
} from './page-navigation-request.js';

const APPLICATION_IDS = new Set(['canvas.pages', 'canvas.page']);
const MAX_PAGES = 4096;
const MAX_PAGE_ID_CODE_UNITS = 256;
const MAX_PAGE_NAME_CODE_UNITS = 4096;
const MAX_AMBIGUOUS_MATCHES = 16;
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function invalidResult() {
  throw new Error('Figma returned an invalid Page Navigation result.');
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

function pageFact(value) {
  const page = pageIdentity(value);
  if (typeof value.current !== 'boolean') invalidResult();
  return { ...page, current: value.current };
}

function pagesResult(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAGES) invalidResult();
  const pages = value.map(pageFact);
  if (pages.filter((page) => page.current).length !== 1) invalidResult();
  return pages;
}

function switchResult(value) {
  if (!record(value) || typeof value.status !== 'string') invalidResult();
  if (value.status === 'not-found') return { status: 'not-found' };
  if (value.status === 'switched') {
    return { status: 'switched', ...pageIdentity(value) };
  }
  if (value.status === 'ambiguous') {
    if (!Number.isSafeInteger(value.count) || value.count < 2
      || !Array.isArray(value.matches) || value.matches.length === 0
      || value.matches.length > MAX_AMBIGUOUS_MATCHES
      || value.matches.length > value.count) {
      invalidResult();
    }
    return {
      status: 'ambiguous',
      count: value.count,
      matches: value.matches.map(pageIdentity),
    };
  }
  invalidResult();
}

function pagesCode() {
  return `(async () => figma.root.children.map((page) => ({
  id: page.id,
  name: page.name,
  current: page.id === figma.currentPage.id,
})))()`;
}

function pageCode(reference) {
  return `(async () => {
const reference = ${JSON.stringify({ kind: reference.kind, value: reference.value })};
const q = reference.value;
const pages = figma.root.children;
let target = reference.kind === 'node' || reference.kind === 'query'
  ? pages.find((page) => page.id === q)
  : null;
let matches = [];
if (!target && reference.kind !== 'node') {
  const exactMatches = pages.filter((page) => page.name === q);
  if (exactMatches.length === 1) target = exactMatches[0];
  else if (exactMatches.length > 1) matches = exactMatches;
}
if (!target && matches.length === 0 && reference.kind === 'query') {
  matches = pages.filter((page) => page.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length === 1) target = matches[0];
}
if (!target && matches.length > 1) {
  return {
    status: 'ambiguous',
    count: matches.length,
    matches: matches.slice(0, ${MAX_AMBIGUOUS_MATCHES}).map((page) => ({
      id: page.id,
      name: page.name,
    })),
  };
}
if (!target) return { status: 'not-found' };
await figma.setCurrentPageAsync(target);
return { status: 'switched', id: target.id, name: target.name };
})()`;
}

function normalizedRequest(request) {
  return parsePageNavigationRequest(pageNavigationArgvFromRequest(request));
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executePageNavigation(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executePageNavigation requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  if (input.action === 'pages') {
    const result = pagesResult(await adapters.evaluate(pagesCode()));
    return {
      stdout: input.json
        ? JSON.stringify(result, null, 2)
        : result.map((page) => `${page.current ? '→ ' : '  '}${safeDisplay(page.name)} (${safeDisplay(page.id)})`).join('\n'),
      stderr: '',
      result,
    };
  }

  const result = switchResult(await adapters.evaluate(pageCode(input.reference)));
  const displayReference = input.reference.value;
  if (result.status === 'not-found') {
    throw new Error(`Page not found: ${safeDisplay(displayReference)}`);
  }
  if (result.status === 'ambiguous') {
    const remainder = result.count - result.matches.length;
    const suffix = remainder > 0 ? ` (and ${remainder} more)` : '';
    throw new Error(
      `Ambiguous page name "${safeDisplay(displayReference)}": `
      + `${result.matches.map((page) => `${safeDisplay(page.name)} (${safeDisplay(page.id)})`).join(', ')}${suffix}`,
    );
  }
  return {
    stdout: `✓ Switched to page: ${safeDisplay(result.name)} (${safeDisplay(result.id)})`,
    stderr: '',
    result,
  };
}

export function pageNavigationPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Page Navigation routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application'
    : 'not-page-navigation';
}

export async function executePageNavigationPlan(plan, adapters = {}) {
  if (pageNavigationPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Page Navigation Command Application.`);
  }
  return executePageNavigation(parsePageNavigationRequest(plan.argv), adapters);
}
