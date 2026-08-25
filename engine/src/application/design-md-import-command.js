// Bounded DESIGN.md import through exact v2 or deep Single-Collection mutation.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  executeTokenImport,
  prepareTokenImportRequestItems,
} from './token-import-command.js';
import { parseTokenImportRequest } from './token-import-request.js';
import { designMdArgvFromRequest, parseDesignMdRequest } from './design-md-request.js';
import {
  designMdVariableSnapshot,
  parseDesignMd,
  summarizeForLLM,
  toSingleCollectionTokenItems,
} from '../design-md.js';
import {
  executeVariableSnapshotImport,
  prepareVariableSnapshotImport,
} from './variable-snapshot-import-command.js';
import {
  compositeStyleImportRequiresFigma,
  executeCompositeStyleImport,
  prepareCompositeStyleImport,
} from './composite-style-import-command.js';

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

export function prepareDesignMdImportRequest(input, { workspaceIO } = {}) {
  if (!workspaceIO || typeof workspaceIO.readText !== 'function') {
    throw new TypeError('DESIGN.md Import requires an authorized WorkspaceIO capability.');
  }
  const request = parseDesignMdRequest(designMdArgvFromRequest(input));
  if (request.printContext) {
    throw new Error('DESIGN.md mutation preparation cannot use --print-context.');
  }
  const parsed = parseDesignMd(request.file, { workspaceIO });
  const summary = summarizeForLLM(parsed);
  const compositeImport = prepareCompositeStyleImport(parsed);
  const variableSource = designMdVariableSnapshot(parsed);
  if (variableSource?.kind === 'portable-v2') {
    if (request.collection !== null || request.forceSlash) {
      throw new Error('--collection and --force-slash apply only to simple single-Collection DESIGN.md imports, not exact Variable Snapshot v2 imports.');
    }
    return preparedImport({
      kind: 'variable-snapshot-v2', request,
      snapshot: prepareVariableSnapshotImport(variableSource.snapshot), compositeImport, summary,
    });
  }
  if (variableSource?.kind === 'legacy-v1'
    && Object.keys(variableSource.snapshot).length) {
    return preparedImport({
      kind: 'legacy-variable-snapshot', request, parsed, summary,
    });
  }
  const items = toSingleCollectionTokenItems(parsed);
  if (!items.length && !compositeStyleImportRequiresFigma(compositeImport)) {
    return preparedImport({
      kind: 'context-only', request, summary,
      unsupportedCompositeCount: compositeImport.unsupported.length,
    });
  }
  const collection = request.collection
    || implicitCollection(parsed.meta.source, request.forceSlash);
  const tokenImport = items.length ? prepareTokenImportRequestItems({
    file: request.file,
    collection,
    forceSlash: request.forceSlash,
  }, items) : null;
  if (!compositeStyleImportRequiresFigma(compositeImport)) {
    return preparedImport({
      kind: 'single-collection', request, tokenImport, summary,
      unsupportedCompositeCount: compositeImport.unsupported.length,
    });
  }
  return preparedImport({
    kind: 'native-design', request, tokenImport, compositeImport, summary,
  });
}

export function prepareDesignMdImportPlan(plan, { workspaceIO } = {}) {
  if (designMdImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by DESIGN.md Import.`);
  }
  return prepareDesignMdImportRequest(parseDesignMdRequest(plan.argv), { workspaceIO });
}

function compositeWarning(count) {
  if (!count) return '';
  return `${count} typography or shadow token${count === 1 ? ' remains' : 's remain'} context-only because they do not have an exact simple Variable representation.`;
}

export async function executeDesignMdImport(prepared, adapters = {}) {
  if (!PREPARED_IMPORTS.has(prepared)) {
    throw new Error('DESIGN.md Import requires its authentic prepared source.');
  }
  if (prepared.kind === 'legacy-variable-snapshot') {
    throw new Error('Legacy name-keyed Variable Snapshot import remains on the compatibility path.');
  }
  if (prepared.kind === 'variable-snapshot-v2') {
    const variableResult = await executeVariableSnapshotImport(prepared.snapshot, adapters);
    const styleResult = await executeCompositeStyleImport(prepared.compositeImport, adapters);
    return {
      stdout: `${[variableResult.stdout, styleResult.stdout].filter(Boolean).join('\n')}\n\n─── agent context summary ───────────\n${prepared.summary}\n──────────────────────────────────────────────`,
      stderr: [variableResult.stderr, styleResult.stderr].filter(Boolean).join('\n'),
      code: 0,
      result: { schemaVersion: 1, variables: variableResult.result, styles: styleResult.result },
    };
  }
  const warning = compositeWarning(prepared.unsupportedCompositeCount);
  if (prepared.kind === 'context-only') {
    return {
      stdout: prepared.summary,
      stderr: warning || 'No COLOR, radius, or spacing tokens have an exact native Variable representation.',
      code: 0,
    };
  }
  if (prepared.kind === 'single-collection') {
    const result = await executeTokenImport(prepared.tokenImport, adapters);
    return {
      stdout: `${result.stdout}\n\n─── agent context summary ───────────\n${prepared.summary}\n──────────────────────────────────────────────`,
      stderr: [result.stderr, warning].filter(Boolean).join('\n'),
      code: result.code ?? 0, result: result.result,
    };
  }
  if (prepared.kind !== 'native-design') {
    throw new Error('DESIGN.md Import received an unknown prepared source kind.');
  }
  const tokenResult = prepared.tokenImport
    ? await executeTokenImport(prepared.tokenImport, adapters) : null;
  const styleResult = await executeCompositeStyleImport(prepared.compositeImport, adapters);
  return {
    stdout: `${[tokenResult?.stdout, styleResult.stdout].filter(Boolean).join('\n')}\n\n─── agent context summary ───────────\n${prepared.summary}\n──────────────────────────────────────────────`,
    stderr: [tokenResult?.stderr, styleResult.stderr].filter(Boolean).join('\n'),
    code: tokenResult?.code ?? styleResult.code ?? 0,
    result: { schemaVersion: 1, variables: tokenResult?.result ?? null, styles: styleResult.result },
  };
}

export async function executeDesignMdImportPlan(plan, prepared, adapters = {}) {
  if (designMdImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by DESIGN.md Import.`);
  }
  const request = parseDesignMdRequest(plan.argv);
  if (!PREPARED_IMPORTS.has(prepared) || !isDeepStrictEqual(prepared.request, request)) {
    throw new Error('DESIGN.md Import requires its authentic prepared source.');
  }
  return executeDesignMdImport(prepared, adapters);
}
