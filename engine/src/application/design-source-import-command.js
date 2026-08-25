// One owning Command Application for top-level design-source import.

import { isDeepStrictEqual } from 'node:util';
import { basename } from 'node:path';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { convert } from '../code-import/index.js';
import {
  designMdCompositeTokenCount,
  parseDesignMdText,
  summarizeForLLM,
  toSingleCollectionTokenItems,
} from '../design-md.js';
import {
  executeDesignMdImport,
  prepareDesignMdImportRequest,
} from './design-md-import-command.js';
import {
  designSourceImportArgvFromRequest,
  parseDesignSourceImportRequest,
} from './design-source-import-request.js';
import {
  executeTokenImport,
  prepareTokenImportRequestItems,
} from './token-import-command.js';

export {
  designSourceImportArgvFromRequest,
  designSourceImportPlanningArgvFromRequest,
} from './design-source-import-request.js';

const APPLICATION_ID = 'import';
const PREPARED_IMPORTS = new WeakSet();

function prepared(value) {
  PREPARED_IMPORTS.add(value);
  return Object.freeze(value);
}

function requiresWorkspace(workspaceIO, { write = false } = {}) {
  if (!workspaceIO || typeof workspaceIO.readText !== 'function'
    || (write && typeof workspaceIO.write !== 'function')) {
    throw new TypeError(write
      ? 'Design Source Import save requires an authorized writable WorkspaceIO capability.'
      : 'Design Source Import requires an authorized readable WorkspaceIO capability.');
  }
  return workspaceIO;
}

function isDesignMd(request) {
  if (request.type === 'designmd') return true;
  if (request.type !== null) return false;
  return /\.md$/i.test(basename(request.source));
}

function sourceSummary(converted) {
  return summarizeForLLM({ tokens: converted.tokens, meta: converted.meta });
}

function compositeWarning(count) {
  if (!count) return '';
  return `${count} typography or shadow token${count === 1 ? ' remains' : 's remain'} context-only because they do not have an exact simple Variable representation.`;
}

function savedPrefix(request) {
  return request.save ? `DESIGN.md saved to ${request.save}.\n` : '';
}

export function designSourceImportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Design Source Import routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-design-source-import';
}

export async function prepareDesignSourceImportPlan(plan, {
  workspaceIO,
  convertSource = convert,
} = {}) {
  if (designSourceImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Design Source Import.`);
  }
  const io = requiresWorkspace(workspaceIO);
  const request = parseDesignSourceImportRequest(plan.argv);
  if (isDesignMd(request)) {
    if (request.printContext) {
      const sourceText = io.readText(request.source, { role: 'import-source' });
      const parsed = parseDesignMdText(sourceText, {
        sourceName: basename(request.source),
        limits: io.limits,
      });
      return prepared({
        kind: 'context-only', request, summary: summarizeForLLM(parsed),
        artifact: sourceText, unsupportedCompositeCount: designMdCompositeTokenCount(parsed),
      });
    }
    const designMd = prepareDesignMdImportRequest({
      file: request.source,
      collection: request.collection,
      printContext: false,
      forceSlash: request.forceSlash,
    }, { workspaceIO: io });
    if (designMd.kind === 'legacy-variable-snapshot') {
      throw new Error('Top-level import requires a Portable Variable Snapshot v2 or simple DESIGN.md; use tokens import-design-md only for the legacy v1 compatibility path.');
    }
    const sourceText = request.save
      ? io.readText(request.source, { role: 'import-source' }) : null;
    return prepared({
      kind: 'design-md', request, designMd,
      artifact: sourceText,
      requiresFigma: ['single-collection', 'variable-snapshot-v2'].includes(designMd.kind),
    });
  }

  const converted = await convertSource(request.source, {
    ...(request.type === null ? {} : { type: request.type }),
    workspaceIO: io,
  });
  if (!converted || typeof converted !== 'object' || Array.isArray(converted)
    || !converted.tokens || !converted.meta || typeof converted.designMd !== 'string') {
    throw new Error('Design Source Import converter returned an invalid bounded result.');
  }
  const summary = sourceSummary(converted);
  const items = toSingleCollectionTokenItems({ tokens: converted.tokens, meta: converted.meta });
  const unsupportedCompositeCount = designMdCompositeTokenCount({ tokens: converted.tokens });
  if (!items.length || request.printContext) {
    return prepared({
      kind: 'context-only', request, summary, artifact: converted.designMd,
      unsupportedCompositeCount,
    });
  }
  const collection = request.collection || converted.meta.source || 'Imported Design System';
  const tokenImport = prepareTokenImportRequestItems({
    file: request.source,
    collection,
    forceSlash: request.forceSlash,
  }, items);
  return prepared({
    kind: 'single-collection', request, summary, artifact: converted.designMd,
    tokenImport, unsupportedCompositeCount, requiresFigma: true,
  });
}

export function designSourceImportRequiresFigma(preparedSource) {
  if (!PREPARED_IMPORTS.has(preparedSource)) {
    throw new Error('Design Source Import requires its authentic prepared source.');
  }
  return preparedSource.requiresFigma === true;
}

export async function executeDesignSourceImportPlan(plan, preparedSource, adapters = {}) {
  if (designSourceImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Design Source Import.`);
  }
  const request = parseDesignSourceImportRequest(plan.argv);
  if (!PREPARED_IMPORTS.has(preparedSource)
    || !isDeepStrictEqual(preparedSource.request, request)) {
    throw new Error('Design Source Import requires its authentic prepared source.');
  }
  const io = requiresWorkspace(adapters.workspaceIO, { write: request.save !== null });
  if (request.save) {
    if (typeof preparedSource.artifact !== 'string') {
      throw new Error('Design Source Import has no converted DESIGN.md artifact to save.');
    }
    io.write(request.save, preparedSource.artifact, { role: 'import-output', createParents: true });
  }
  const prefix = savedPrefix(request);
  if (request.printContext || preparedSource.kind === 'context-only') {
    return {
      stdout: `${prefix}${preparedSource.summary}`,
      stderr: compositeWarning(preparedSource.unsupportedCompositeCount),
      code: 0,
    };
  }
  if (preparedSource.kind === 'design-md') {
    const result = await executeDesignMdImport(preparedSource.designMd, adapters);
    return { ...result, stdout: `${prefix}${result.stdout}` };
  }
  if (preparedSource.kind !== 'single-collection') {
    throw new Error('Design Source Import received an unknown prepared source kind.');
  }
  const result = await executeTokenImport(preparedSource.tokenImport, adapters);
  return {
    stdout: `${prefix}${result.stdout}\n\n─── agent context summary ───────────\n${preparedSource.summary}\n──────────────────────────────────────────────`,
    stderr: [result.stderr, compositeWarning(preparedSource.unsupportedCompositeCount)]
      .filter(Boolean).join('\n'),
    code: result.code ?? 0,
    result: result.result,
  };
}
