import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { createDesignCaptureModule } from './design-capture.js';
import {
  designContractArgvFromRequest,
  parseDesignContractRequest,
} from './design-contract-request.js';
import { readDesignLinkRegistry, resolveDesignEntity } from '../lib/design-link-registry.js';
import {
  buildDesignContract,
  checkDesignContract,
  formatDesignContractCheck,
  serializeDesignContract,
} from '../lib/design-contract.js';
import { parseBoundedJson } from '../lib/workspace-io.js';

export { designContractArgvFromRequest } from './design-contract-request.js';

const uncachedCapture = createDesignCaptureModule({ maxEntries: 0, maxBytes: 0 });
const DESIGN_CONTRACT_APPLICATION_IDS = new Set(['contract.capture', 'contract.check']);

export function designContractRequestFromArgv(args) {
  return parseDesignContractRequest(args);
}

export function designContractPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Design Contract routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && DESIGN_CONTRACT_APPLICATION_IDS.has(plan.id)
    ? 'command-application'
    : 'not-design-contract';
}

export async function executeDesignContractPlan(plan, adapters = {}) {
  if (designContractPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Design Contract Command Application.`);
  }
  return executeDesignContract(designContractRequestFromArgv(plan.argv), adapters);
}

function entityFor(manifestPath, entityId, io = null) {
  const loaded = readDesignLinkRegistry(dirname(manifestPath), {
    manifestPath,
    ...(io ? { io } : {}),
  });
  const entity = resolveDesignEntity(loaded.registry, { id: entityId });
  if (!entity) throw new Error(`Design Entity not found: ${entityId}`);
  if (!entity.figma?.nodeId) throw new Error(`Design Entity ${entity.id} has no Figma node link.`);
  return entity;
}

async function captureFor(entity, request, adapters) {
  if (typeof adapters.captureDesign === 'function') {
    return adapters.captureDesign({
      nodeId: entity.figma.nodeId,
      fileKey: entity.figma.fileKey || null,
      depth: request.depth,
      includeHidden: request.includeHidden === true,
    });
  }
  if (typeof adapters.evaluate !== 'function') {
    throw new Error('Design Contract command requires a Figma evaluate adapter.');
  }
  return uncachedCapture.capture({
    nodeId: entity.figma.nodeId,
    fileKey: entity.figma.fileKey || null,
    depth: request.depth,
    includeHidden: request.includeHidden === true,
  }, { evaluate: adapters.evaluate });
}

export async function executeDesignContract(request, adapters = {}) {
  if (!request?.manifestPath) throw new Error('Design Link Registry path is required.');
  if (!request.contractPath) throw new Error('Design Contract file path is required.');
  if (!['capture', 'check'].includes(request.action)) {
    throw new Error(`Unknown Design Contract action: ${request.action || '(missing)'}`);
  }
  const depth = request.depth === undefined ? 12 : Number(request.depth);
  if (!Number.isInteger(depth) || depth < 0 || depth > 30) {
    throw new Error('Design Contract depth must be an integer from 0 to 30.');
  }
  const geometryTolerance = Number(request.geometryTolerance ?? 0.5);
  if (!Number.isFinite(geometryTolerance) || geometryTolerance < 0) {
    throw new Error('Design Contract geometry tolerance must be a finite non-negative number.');
  }
  const maxDiffs = request.maxDiffs === undefined ? undefined : Number(request.maxDiffs);
  if (maxDiffs !== undefined && (!Number.isInteger(maxDiffs) || maxDiffs < 1)) {
    throw new Error('Design Contract max diffs must be a positive integer.');
  }
  const io = adapters.workspaceIO || null;
  const entity = entityFor(request.manifestPath, request.entityId, io);
  const capture = await captureFor(entity, {
    ...request,
    depth,
  }, adapters);

  if (request.action === 'capture') {
    const contract = buildDesignContract({
      entity, capture,
      geometryTolerance,
    });
    const write = adapters.writeContract || (io
      ? ((path, content) => io.write(path, content, { role: 'design-contract-file', createParents: true }))
      : ((path, content) => writeFileSync(path, content)));
    await write(request.contractPath, serializeDesignContract(contract));
    return { action: 'capture', entity, contract, path: request.contractPath };
  }
  if (request.action === 'check') {
    const read = adapters.readContract || (io
      ? ((path) => io.readText(path, { role: 'design-contract-file' }))
      : ((path) => readFileSync(path, 'utf8')));
    if (!adapters.readContract && !existsSync(request.contractPath)) {
      throw new Error(`Design Contract not found: ${request.contractPath}`);
    }
    let contract;
    try {
      contract = parseBoundedJson(await read(request.contractPath), {
        role: 'design-contract-file',
        limits: io?.limits,
      });
    }
    catch (error) { throw new Error(`Invalid Design Contract ${request.contractPath}: ${error.message}`); }
    if (contract.entity?.id !== entity.id) {
      throw new Error(`Design Contract belongs to ${contract.entity?.id || '(unknown)'}, not ${entity.id}.`);
    }
    const check = checkDesignContract(contract, capture, { maxDiffs });
    return { action: 'check', entity, contract, check, path: request.contractPath };
  }
}

export function formatDesignContractResult(result) {
  if (result.action === 'capture') {
    const sets = result.contract.rules.componentSets.length;
    return `Captured Design Contract for ${result.entity.id}\n`
      + `  file: ${result.path}\n`
      + `  roots: ${result.contract.rules.roots.length}\n`
      + `  component sets: ${sets}`;
  }
  return `${formatDesignContractCheck(result.contract, result.check)}\n\ncontract: ${result.path}`;
}

export function designContractResultRows(result) {
  if (result.action === 'capture') {
    return [{ marker: '✓', markerTone: 'success', text: formatDesignContractResult(result) }];
  }
  if (result.action === 'check') {
    return [{
      marker: result.check.ok ? '✓' : '✗',
      markerTone: result.check.ok ? 'success' : 'error',
      text: formatDesignContractResult(result),
    }];
  }
  throw new Error(`Design Contract result rows are not defined for ${result.action || '(missing)'}.`);
}

export function formatDesignContractAdapterResult(result) {
  return designContractResultRows(result)
    .map((row) => `${row.marker} ${row.text}`)
    .join('\n');
}

export function designContractFileKeyFromArgv(args, { io = null } = {}) {
  if (!Array.isArray(args) || args[0] !== 'contract') return null;
  const request = parseDesignContractRequest(args, { requirePaths: false });
  if (!request.entityId || !request.manifestPath) return null;
  const loaded = readDesignLinkRegistry(dirname(request.manifestPath), {
    manifestPath: request.manifestPath,
    ...(io ? { io } : {}),
  });
  return resolveDesignEntity(loaded.registry, { id: request.entityId })?.figma?.fileKey || null;
}
