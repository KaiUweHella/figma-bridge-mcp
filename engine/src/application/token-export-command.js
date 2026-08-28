// Exact CSS/DTCG Token Export Command Application.
//
// One small Interface hides two capture Implementations:
// - an explicit node uses one bounded subtree read and includes library tokens;
// - a file-wide request captures every local Variable in revision-pinned chunks.
// Commander and MCP are adapters at this seam and never own capture,
// validation, formatting or persistence decisions.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  exactVariableCatalog,
  exactVariableChunk,
  stableVariableCatalog,
  usedVariablesCode,
  variableChunkCode,
  variableCollectionsCode,
} from '../design-extract.js';
import { buildDtcgTree, formatCssTokens, projectVariableModes } from '../lib/css-tokens.js';
import { createRevisionContext } from '../lib/revision-context.js';
import { DEFAULT_WORKSPACE_LIMITS, parseBoundedJson } from '../lib/workspace-io.js';
import {
  parseTokenExportRequest,
  tokenExportArgvFromRequest,
  tokenExportPlanningArgvFromRequest,
} from './token-export-request.js';

export {
  tokenExportArgvFromRequest,
  tokenExportPlanningArgvFromRequest,
} from './token-export-request.js';

const APPLICATION_IDS = new Set(['export.css', 'export.dtcg']);
const VARIABLE_CHUNK = 200;
const VARIABLE_CHUNK_FLOOR = 25;
const MAX_TEXT = 16_384;
const MAX_IDENTITY = 512;
const VARIABLE_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const UNSAFE_IDENTITY = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function parseEval(value, role) {
  if (typeof value !== 'string') return value;
  try { return parseBoundedJson(value, { role }); }
  catch { throw new Error(`Token Export returned invalid or oversized ${role} JSON.`); }
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function identity(value, { empty = false, max = MAX_IDENTITY } = {}) {
  return typeof value === 'string' && value.length <= max
    && (empty || value.length > 0) && !UNSAFE_IDENTITY.test(value);
}

function scalarValue(value, type) {
  if (value === null) return true;
  if (type === 'COLOR') return typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
  if (type === 'FLOAT' || type === 'TIMING') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'BOOLEAN') return typeof value === 'boolean';
  if (type === 'STRING') return typeof value === 'string' && value.length <= MAX_TEXT;
  // The existing scoped collector deliberately leaves composite EASING facts
  // unresolved rather than serializing a misleading CSS/DTCG value.
  return value === null;
}

function validScopedVariable(variable) {
  if (!exactKeys(variable,
    ['id', 'name', 'type', 'value', 'ref', 'refId', 'valuesByMode', 'modes',
      'defaultModeId', 'collection'],
    ['description', 'scopes', 'codeSyntax'])
    || !identity(variable.id) || !identity(variable.name)
    || !VARIABLE_TYPES.has(variable.type)
    || !identity(variable.defaultModeId)
    || !(variable.collection === null || identity(variable.collection, { empty: true }))
    || !(variable.ref === null || identity(variable.ref))
    || !(variable.refId === null || identity(variable.refId))
    || !scalarValue(variable.value, variable.type)
    || !Array.isArray(variable.modes) || variable.modes.length > 1_000
    || !variable.valuesByMode || typeof variable.valuesByMode !== 'object'
    || Array.isArray(variable.valuesByMode)) return false;
  const modeIds = new Set();
  for (const mode of variable.modes) {
    if (!exactKeys(mode, ['modeId', 'name']) || !identity(mode.modeId)
      || !identity(mode.name, { empty: true }) || modeIds.has(mode.modeId)) return false;
    modeIds.add(mode.modeId);
    const stored = variable.valuesByMode[mode.modeId];
    if (!exactKeys(stored, ['value', 'ref', 'refId'])
      || !(stored.ref === null || identity(stored.ref))
      || !(stored.refId === null || identity(stored.refId))
      || !scalarValue(stored.value, variable.type)) return false;
  }
  if (!modeIds.has(variable.defaultModeId)
    || Object.keys(variable.valuesByMode).length !== modeIds.size
    || Object.keys(variable.valuesByMode).some((modeId) => !modeIds.has(modeId))) return false;
  if (variable.description !== undefined
    && (typeof variable.description !== 'string' || variable.description.length > MAX_TEXT)) return false;
  if (variable.scopes !== undefined && (!Array.isArray(variable.scopes)
    || variable.scopes.length > 32
    || variable.scopes.some((scope) => !identity(scope)))) return false;
  if (variable.codeSyntax !== undefined && (!variable.codeSyntax
    || typeof variable.codeSyntax !== 'object' || Array.isArray(variable.codeSyntax)
    || Object.entries(variable.codeSyntax).some(([platform, syntax]) =>
      !['WEB', 'ANDROID', 'iOS'].includes(platform)
      || typeof syntax !== 'string' || syntax.length > 1_024))) return false;
  return true;
}

function exactScopedCapture(raw, requestedNodeId) {
  const value = parseEval(raw, 'scoped-token-export');
  if (value?.error) throw new Error(String(value.error));
  if (!exactKeys(value, [
    'schemaVersion', 'scope', 'complete', 'file', 'node', 'id', 'visitedNodes',
    'referencedVariables', 'returnedVariables', 'vars',
  ]) || value.schemaVersion !== 1 || value.scope !== 'subtree' || value.complete !== true
    || !identity(value.file, { max: 1_024 }) || !identity(value.node, { max: 1_024 })
    || value.id !== requestedNodeId
    || !Number.isSafeInteger(value.visitedNodes) || value.visitedNodes < 1
    || value.visitedNodes > 100_000
    || !Number.isSafeInteger(value.referencedVariables)
    || value.referencedVariables < 0 || value.referencedVariables > 10_000
    || !Number.isSafeInteger(value.returnedVariables)
    || value.returnedVariables !== value.referencedVariables
    || !Array.isArray(value.vars) || value.vars.length !== value.returnedVariables
    || value.vars.some((variable) => !validScopedVariable(variable))
    || new Set(value.vars.map((variable) => variable.id)).size !== value.vars.length) {
    throw new Error('Token Export returned an invalid or incomplete scoped result.');
  }
  return value;
}

function projectedLocalVariables(collections) {
  const rawCollections = collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({ modeId: mode.id, name: mode.name })),
  }));
  const rawVariables = collections.flatMap((collection) =>
    collection.variables.map((variable) => ({
      id: variable.id,
      name: variable.name,
      resolvedType: variable.type,
      variableCollectionId: variable.variableCollectionId,
      valuesByMode: Object.fromEntries(Object.entries(variable.exactValues).map(([modeId, value]) => [
        modeId,
        value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).length === 1 && typeof value.alias === 'string'
          ? { type: 'VARIABLE_ALIAS', id: value.alias }
          : value,
      ])),
      description: variable.description,
      scopes: variable.scopes,
      codeSyntax: variable.codeSyntax,
    })),
  );
  return projectVariableModes(rawVariables, rawCollections);
}

function evaluatedResponse(response, role) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || !Object.hasOwn(response, 'value') || !Object.hasOwn(response, 'metadata')) {
    throw new Error(`Token Export requires daemon revision metadata for ${role}.`);
  }
  return response;
}

async function captureFileVariables(adapters) {
  const revisionContext = createRevisionContext({
    expectedFileKey: adapters.fileKey || null,
    revisionObservation: { scope: 'document' },
  });
  const evaluate = async (code, role) => {
    const response = evaluatedResponse(await adapters.evaluate(code, {
      fileKey: revisionContext.targetFileKey(),
      revisionObservation: revisionContext.observation(),
      remainingMs: adapters.remainingMs?.(),
    }), role);
    revisionContext.accept(response.metadata, role);
    return parseEval(response.value, role);
  };

  const first = await evaluate(variableCollectionsCode({ withFile: true }), 'initial Variable catalog');
  if (!exactKeys(first, ['file', 'catalog']) || !identity(first.file, { max: 1_024 })) {
    throw new Error('Token Export returned invalid file identity with the Variable catalog.');
  }
  const catalog = exactVariableCatalog(first.catalog);
  const captured = [];
  let capturedBytes = 2;
  let capturedEntries = 0;
  for (let collectionIndex = 0; collectionIndex < catalog.length; collectionIndex++) {
    const collection = catalog[collectionIndex];
    const variables = [];
    let chunkSize = VARIABLE_CHUNK;
    for (let index = 0; index < collection.variableIds.length;) {
      const ids = collection.variableIds.slice(index, index + chunkSize);
      try {
        const exact = exactVariableChunk(ids, collection, await evaluate(
          variableChunkCode(ids, collection.modes),
          `Variable chunk ${collectionIndex + 1}:${index}`,
        ));
        if (!exact) throw new Error('Token Export did not receive the exact requested Variable chunk.');
        capturedBytes += exact.bytes;
        capturedEntries += exact.entries;
        if (capturedBytes > DEFAULT_WORKSPACE_LIMITS.jsonBytes
          || capturedEntries > DEFAULT_WORKSPACE_LIMITS.collectionEntries) {
          throw Object.assign(new Error('Token Export exceeds the Workspace byte or structure limits.'), {
            code: 'TOKEN_EXPORT_LIMIT',
          });
        }
        variables.push(...exact.variables);
        index += ids.length;
      } catch (error) {
        if (error.code !== 'TOKEN_EXPORT_LIMIT'
          && /payload|too large|timeout/i.test(error.message)
          && chunkSize > VARIABLE_CHUNK_FLOOR) {
          chunkSize = Math.max(VARIABLE_CHUNK_FLOOR, Math.floor(chunkSize / 2));
          continue;
        }
        throw error;
      }
    }
    captured.push({ ...collection, variables });
  }

  const final = await evaluate(variableCollectionsCode({ withFile: true }), 'final Variable catalog');
  if (!exactKeys(final, ['file', 'catalog']) || final.file !== first.file
    || !stableVariableCatalog(catalog, exactVariableCatalog(final.catalog))) {
    throw new Error('The Figma Variable catalog changed during Token Export; retry from the new revision.');
  }
  if (revisionContext.source()?.proof !== 'document-revision') {
    throw new Error('The connected Figma Bridge plugin cannot prove one document revision for exact Token Export. Re-import or update the plugin, then retry.');
  }
  return { file: first.file, vars: projectedLocalVariables(captured) };
}

async function captureTokens(input, adapters) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Token Export requires evaluate(code, context).');
  }
  if (input.nodeId) {
    const response = evaluatedResponse(await adapters.evaluate(usedVariablesCode(input.nodeId), {
      fileKey: adapters.fileKey || null,
      remainingMs: adapters.remainingMs?.(),
    }), 'scoped Variable capture');
    return exactScopedCapture(response.value, input.nodeId);
  }
  return captureFileVariables(adapters);
}

function noTokensError(input, capture) {
  const scope = input.nodeId
    ? `under node "${capture.node || input.nodeId}"`
    : 'in the open file';
  const hint = input.nodeId
    ? `Run \`export ${input.format}\` without a node id only if you really want the whole file's local variables.`
    : 'Create or bind Variables in Figma, then retry.';
  return new Error(`No variables are available ${scope}. ${hint}`);
}

function cssCommentText(value) {
  return String(value).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ');
}

function boundedProjection(value) {
  if (Buffer.byteLength(value, 'utf8') > DEFAULT_WORKSPACE_LIMITS.textBytes) {
    throw new Error('Token Export projection exceeds the Workspace text limit. Narrow the export to a node subtree.');
  }
  return value;
}

export async function executeTokenExport(request, adapters = {}) {
  const input = parseTokenExportRequest(tokenExportArgvFromRequest(request));
  const capture = await captureTokens(input, adapters);
  if (!Array.isArray(capture.vars) || capture.vars.length === 0) {
    throw noTokensError(input, capture);
  }

  const scopedSource = input.nodeId
    ? `Figma file "${capture.file}" — ${capture.vars.length} token(s) actually bound under "${capture.node}" (${capture.id})`
    : `Figma file "${capture.file}" — all ${capture.vars.length} local token(s)`;
  const broadWarning = input.nodeId ? ''
    : `⚠ no node id given — exporting ALL local variables of the open file. If this file contains more than one design system, pass the frame's node id/URL to scope the tokens.\n`;

  if (input.format === 'css') {
    const collections = input.nodeId
      ? [...new Set(capture.vars.map((variable) => variable.collection).filter(Boolean))]
      : [];
    const source = `/* source: ${cssCommentText(scopedSource)}${collections.length
      ? `; collections: ${collections.map(cssCommentText).join(', ')}` : ''} */`;
    return {
      stdout: boundedProjection(`${source}\n${formatCssTokens(capture.vars)}`),
      stderr: broadWarning.trimEnd(),
      result: { format: 'css', scope: input.nodeId ? 'subtree' : 'file', tokenCount: capture.vars.length },
    };
  }

  const json = boundedProjection(JSON.stringify(
    buildDtcgTree(capture.vars, { dialect: input.dialect }), null, 2,
  ));
  let stdout = json;
  if (input.output) {
    if (!adapters.workspaceIO || typeof adapters.workspaceIO.write !== 'function') {
      throw new TypeError('DTCG file output requires WorkspaceIO.');
    }
    adapters.workspaceIO.write(input.output, `${json}\n`, {
      role: 'dtcg-output', createParents: true,
    });
    stdout = `✓ Wrote DTCG tokens → ${input.output}`;
  }
  return {
    stdout,
    stderr: `${broadWarning}source: ${scopedSource}`.trimEnd(),
    result: {
      format: 'dtcg', dialect: input.dialect,
      scope: input.nodeId ? 'subtree' : 'file', tokenCount: capture.vars.length,
      output: input.output,
    },
  };
}

export function tokenExportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Token Export routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-token-export';
}

export async function executeTokenExportPlan(plan, adapters = {}) {
  if (tokenExportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Export.`);
  }
  const request = parseTokenExportRequest(plan.argv);
  const plannedOutput = plan.outputs.find((output) => output.role === 'dtcg-output')?.path || null;
  if ((request.output || null) !== plannedOutput) {
    throw new Error('Token Export output does not match its immutable Command Plan.');
  }
  return executeTokenExport(request, {
    ...adapters,
    fileKey: plan.target.fileKey || null,
  });
}
