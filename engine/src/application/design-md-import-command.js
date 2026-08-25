// Bounded simple DESIGN.md import through the deep Single-Collection mutation.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  executeTokenImport,
  prepareTokenImportRequestItems,
} from './token-import-command.js';
import { parseTokenImportRequest } from './token-import-request.js';
import { parseDesignMdRequest } from './design-md-request.js';
import {
  designMdCompositeTokenCount,
  designMdVariableSnapshot,
  parseDesignMd,
  summarizeForLLM,
  toSingleCollectionTokenItems,
} from '../design-md.js';

const APPLICATION_ID = 'tokens.import-design-md';
const PREPARED_IMPORTS = new WeakSet();

export function designMdImportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('DESIGN.md Import routing requires a Command Plan created by the Capability Catalog.');
  }
  if (!plan.allowed || plan.id !== APPLICATION_ID) return 'not-design-md-import';
  return parseDesignMdRequest(plan.argv).printContext
    ? 'not-design-md-import' : 'command-application';
}

function preparedImport(value) {
  PREPARED_IMPORTS.add(value);
  return Object.freeze(value);
}

function implicitCollection(source, forceSlash) {
  if (typeof source !== 'string') return 'Imported Design System';
  try {
    return parseTokenImportRequest([
      'tokens', 'import', `--collection=${source}`,
      ...(forceSlash ? ['--force-slash'] : []), '--', 'DESIGN.md',
    ]).collection;
  } catch {
    return 'Imported Design System';
  }
}

export function prepareDesignMdImportPlan(plan, { workspaceIO } = {}) {
  if (designMdImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by DESIGN.md Import.`);
  }
  if (!workspaceIO || typeof workspaceIO.readText !== 'function') {
    throw new TypeError('DESIGN.md Import requires an authorized WorkspaceIO capability.');
  }
  const request = parseDesignMdRequest(plan.argv);
  const parsed = parseDesignMd(request.file, { workspaceIO });
  const summary = summarizeForLLM(parsed);
  const snapshot = designMdVariableSnapshot(parsed);
  if (snapshot && Object.keys(snapshot).length) {
    return preparedImport({
      kind: 'legacy-variable-snapshot', request, parsed, summary,
    });
  }
  const items = toSingleCollectionTokenItems(parsed);
  const unsupportedCompositeCount = designMdCompositeTokenCount(parsed);
  if (!items.length) {
    return preparedImport({
      kind: 'context-only', request, summary, unsupportedCompositeCount,
    });
  }
  const collection = request.collection
    || implicitCollection(parsed.meta.source, request.forceSlash);
  const tokenImport = prepareTokenImportRequestItems({
    file: request.file,
    collection,
    forceSlash: request.forceSlash,
  }, items);
  return preparedImport({
    kind: 'single-collection', request, tokenImport, summary,
    unsupportedCompositeCount,
  });
}

function compositeWarning(count) {
  if (!count) return '';
  return `${count} typography or shadow token${count === 1 ? ' remains' : 's remain'} context-only because they do not have an exact simple Variable representation.`;
}

export async function executeDesignMdImportPlan(plan, prepared, adapters = {}) {
  if (designMdImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by DESIGN.md Import.`);
  }
  const request = parseDesignMdRequest(plan.argv);
  if (!PREPARED_IMPORTS.has(prepared) || !isDeepStrictEqual(prepared.request, request)) {
    throw new Error('DESIGN.md Import requires its authentic prepared source.');
  }
  if (prepared.kind === 'legacy-variable-snapshot') {
    throw new Error('Variable Snapshot import is owned by a separate migration path.');
  }
  const warning = compositeWarning(prepared.unsupportedCompositeCount);
  if (prepared.kind === 'context-only') {
    return {
      stdout: prepared.summary,
      stderr: warning || 'No COLOR, radius, or spacing tokens have an exact native Variable representation.',
      code: 0,
    };
  }
  if (prepared.kind !== 'single-collection') {
    throw new Error('DESIGN.md Import received an unknown prepared source kind.');
  }
  const result = await executeTokenImport(prepared.tokenImport, adapters);
  return {
    stdout: `${result.stdout}\n\n─── agent context summary ───────────\n${prepared.summary}\n──────────────────────────────────────────────`,
    stderr: [result.stderr, warning].filter(Boolean).join('\n'),
    code: result.code ?? 0,
    result: result.result,
  };
}
