// Closed request projection for Figma Slides deck lint.

import { parseSlidesReferenceRequest } from './slides-reference-request.js';

export const SLIDES_LINT_KINDS = Object.freeze([
  'duplicate-name', 'skipped-placement', 'missing-transition', 'empty-slide',
]);
export const DEFAULT_SLIDES_LINT_LIMIT = 20;
export const MAX_SLIDES_LINT_LIMIT = 1_000;

const KINDS = new Set(SLIDES_LINT_KINDS);

function requestError(message) {
  return new Error(`Invalid Slides command: ${message}.`);
}

function optionValues(args) {
  const values = { kinds: undefined, limit: undefined, failOnIssues: false };
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break;
    if (!token.startsWith('--')) continue;
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (seen.has(name)) throw requestError(`duplicate option ${name}`);
    seen.add(name);
    if (name === '--fail-on-issues') {
      values.failOnIssues = true;
      continue;
    }
    const raw = equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (equals === -1) index++;
    if (name === '--kinds') values.kinds = raw;
    else if (name === '--limit') values.limit = raw;
  }
  return values;
}

export function parseSlidesLintRequest(args) {
  // The group grammar owns positional bounds and unknown-option refusal.
  const base = parseSlidesReferenceRequest(args);
  if (base.action !== 'lint') throw new Error('Expected a Slides lint command.');
  const values = optionValues(base.argv);

  let kinds = SLIDES_LINT_KINDS;
  if (values.kinds !== undefined) {
    const requested = String(values.kinds).split(',').map((part) => part.trim()).filter(Boolean);
    if (!requested.length) throw requestError('--kinds must name at least one finding kind');
    for (const kind of requested) {
      if (!KINDS.has(kind)) {
        throw requestError(`unknown lint kind ${kind}; expected ${SLIDES_LINT_KINDS.join(', ')}`);
      }
    }
    kinds = Object.freeze([...new Set(requested)]);
  }

  let limit = DEFAULT_SLIDES_LINT_LIMIT;
  if (values.limit !== undefined) {
    const parsed = Number(values.limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SLIDES_LINT_LIMIT) {
      throw requestError(`--limit must be an integer between 1 and ${MAX_SLIDES_LINT_LIMIT}`);
    }
    limit = parsed;
  }

  return Object.freeze({
    action: 'lint',
    argv: base.argv,
    kinds,
    limit,
    failOnIssues: values.failOnIssues,
  });
}

export function acceptsSlidesLintArgv(args) {
  try {
    parseSlidesLintRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function slidesLintArgvFromRequest(request) {
  const args = ['slides', 'lint'];
  const kinds = request?.kinds;
  if (Array.isArray(kinds) && kinds.length && kinds.length !== SLIDES_LINT_KINDS.length) {
    args.push(`--kinds=${kinds.join(',')}`);
  }
  if (request?.limit != null && request.limit !== DEFAULT_SLIDES_LINT_LIMIT) {
    args.push(`--limit=${request.limit}`);
  }
  if (request?.failOnIssues === true) args.push('--fail-on-issues');
  parseSlidesLintRequest(args);
  return args;
}

export function slidesLintPlanningArgvFromRequest(request) {
  return slidesLintArgvFromRequest(request);
}
