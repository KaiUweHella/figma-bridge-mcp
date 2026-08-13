// Command Application for durable Design Entity links.
//
// One Interface owns both adapters: authenticated Figma plugin data and the
// repository's figma-bridge.json. Commander is only a presentation adapter;
// tests call this Module directly with an evaluate adapter.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve as resolvePath } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { buildSnapshotEval, normalizeSnapshot } from '../lib/doc-snapshot.js';
import { diffImages } from '../lib/image-diff.js';
import {
  acceptedRoundTripBaseline,
  fingerprintCodeSource,
  fingerprintFigmaSnapshot,
  formatProjectDesignContext,
  formatRoundTripPlan,
  planRoundTrip,
  projectDesignContext,
} from '../lib/round-trip-planner.js';
import {
  DESIGN_ENTITY_PLUGIN_DATA_KEY,
  DESIGN_ENTITY_PLUGIN_DATA_VERSION,
  normalizeDesignEntityId,
  normalizeDesignEntityKind,
  normalizeRepositoryPath,
  parseDesignEntityPluginData,
  readDesignLinkRegistry,
  resolveDesignEntity,
  upsertDesignEntity,
  writeDesignLinkRegistry,
} from '../lib/design-link-registry.js';

function nodeExpression(nodeId) {
  return nodeId
    ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
    : 'figma.currentPage.selection[0]';
}

export function exportDesignEntityPngCode(nodeId) {
  return `(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!n) throw new Error(${JSON.stringify(`Node not found: ${nodeId}`)});
    if (!('exportAsync' in n)) throw new Error('Design Entity cannot be exported as PNG');
    const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    return { base64: figma.base64Encode(bytes), width: n.width, height: n.height };
  })()`;
}

function decodeRaster(buffer, extension = '.png') {
  if (extension === '.jpg' || extension === '.jpeg') {
    const image = jpeg.decode(buffer, { useTArray: true });
    return { width: image.width, height: image.height, data: image.data };
  }
  const image = PNG.sync.read(buffer);
  return { width: image.width, height: image.height, data: image.data };
}

function imageHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function verifyVisualParity(request, entity, nodeId, adapters) {
  if (!request.comparePath) {
    if (entity.kind === 'screen') {
      throw new Error(
        `Screen baseline ${entity.id} requires visual proof. Pass --compare <browser-screenshot.png|jpg> and optionally --max-diff <percent>.`,
      );
    }
    return null;
  }
  const maxDiff = request.maxDiff === undefined ? 5 : Number(request.maxDiff);
  if (!Number.isFinite(maxDiff) || maxDiff < 0 || maxDiff > 100) {
    throw new Error(`--max-diff must be a percentage from 0 to 100, got ${request.maxDiff}.`);
  }
  if (typeof adapters.verifyVisual === 'function') {
    return adapters.verifyVisual({ entity, nodeId, comparePath: request.comparePath, maxDiff });
  }
  let buildBuffer;
  try { buildBuffer = readFileSync(request.comparePath); } catch (error) {
    throw new Error(`Cannot read visual comparison image ${request.comparePath}: ${error.message}`);
  }
  const designExport = await adapters.evaluate(exportDesignEntityPngCode(nodeId));
  if (!designExport?.base64) throw new Error('Figma visual comparison export returned no PNG.');
  const designBuffer = Buffer.from(designExport.base64, 'base64');
  let buildImage;
  let designImage;
  try {
    buildImage = decodeRaster(buildBuffer, extname(request.comparePath).toLowerCase());
    designImage = decodeRaster(designBuffer, '.png');
  } catch (error) {
    throw new Error(`Cannot decode visual comparison images: ${error.message}`);
  }
  const comparison = diffImages(designImage, buildImage);
  if (comparison.heightMismatch) {
    throw new Error(
      `Visual parity failed for ${entity.id}: build is ${comparison.heightMismatch.deltaPct}% ${comparison.heightMismatch.direction}.`,
    );
  }
  if (comparison.diffPct > maxDiff) {
    throw new Error(
      `Visual parity failed for ${entity.id}: ${comparison.diffPct}% differs (maximum ${maxDiff}%).`,
    );
  }
  return {
    diffPct: comparison.diffPct,
    maxDiff,
    comparedAt: new Date().toISOString(),
    buildHash: imageHash(buildBuffer),
    figmaPngHash: imageHash(designBuffer),
  };
}

export function inspectDesignEntityCode(nodeId = null) {
  return `(async () => {
    const n = ${nodeExpression(nodeId)};
    if (!n) throw new Error(${JSON.stringify(nodeId ? `Node not found: ${nodeId}` : 'No Figma node selected')});
    let componentKey = null, variantKey = null;
    try {
      if (n.type === 'COMPONENT_SET') componentKey = n.key || null;
      else if (n.type === 'COMPONENT') componentKey = n.key || null;
      else if (n.type === 'INSTANCE') {
        const main = await n.getMainComponentAsync();
        if (main) {
          variantKey = main.key || null;
          componentKey = main.parent && main.parent.type === 'COMPONENT_SET'
            ? (main.parent.key || null) : variantKey;
        }
      }
    } catch (e) {}
    let pluginData = '';
    try { pluginData = n.getPluginData(${JSON.stringify(DESIGN_ENTITY_PLUGIN_DATA_KEY)}) || ''; } catch (e) {}
    return {
      id: n.id, name: n.name, type: n.type,
      fileKey: (typeof figma.fileKey === 'string' && figma.fileKey) || null,
      fileName: figma.root.name,
      componentKey, variantKey, pluginData,
    };
  })()`;
}

export function setDesignEntityCode({ nodeId, entityId, kind = null }) {
  const id = normalizeDesignEntityId(entityId);
  const explicitKind = kind ? normalizeDesignEntityKind(kind) : null;
  return `(async () => {
    const n = ${nodeExpression(nodeId)};
    if (!n) throw new Error(${JSON.stringify(nodeId ? `Node not found: ${nodeId}` : 'No Figma node selected')});
    if (typeof n.setPluginData !== 'function') throw new Error('Node does not support plugin data');
    const kind = ${explicitKind ? JSON.stringify(explicitKind) : `(n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE' ? 'component' : 'frame')`};
    n.setPluginData(${JSON.stringify(DESIGN_ENTITY_PLUGIN_DATA_KEY)}, JSON.stringify({
      version: ${DESIGN_ENTITY_PLUGIN_DATA_VERSION}, id: ${JSON.stringify(id)}, kind,
    }));
    let componentKey = null, variantKey = null;
    try {
      if (n.type === 'COMPONENT_SET') componentKey = n.key || null;
      else if (n.type === 'COMPONENT') componentKey = n.key || null;
      else if (n.type === 'INSTANCE') {
        const main = await n.getMainComponentAsync();
        if (main) {
          variantKey = main.key || null;
          componentKey = main.parent && main.parent.type === 'COMPONENT_SET'
            ? (main.parent.key || null) : variantKey;
        }
      }
    } catch (e) {}
    return {
      id: n.id, name: n.name, type: n.type, entityId: ${JSON.stringify(id)}, kind,
      fileKey: (typeof figma.fileKey === 'string' && figma.fileKey) || null,
      fileName: figma.root.name,
      componentKey, variantKey,
    };
  })()`;
}

function codeLink(request, projectRoot) {
  const path = normalizeRepositoryPath(request.source, projectRoot);
  return {
    ...(path ? { path } : {}),
    ...(request.exportName ? { export: String(request.exportName).trim() } : {}),
  };
}

function storybookLink(request) {
  return {
    ...(request.storyId ? { storyId: String(request.storyId).trim() } : {}),
  };
}

function explicitEntity(loaded, entityId) {
  const entity = resolveDesignEntity(loaded.registry, { id: normalizeDesignEntityId(entityId) });
  if (!entity) throw new Error(`Design Entity not found: ${entityId}`);
  return entity;
}

async function liveEntity(request, loaded, evaluate) {
  if (request.entityId) {
    const entity = explicitEntity(loaded, request.entityId);
    const nodeId = request.nodeId || entity.figma?.nodeId;
    if (!nodeId) return { entity, nodeId };
    const figma = await evaluate(inspectDesignEntityCode(nodeId));
    const plugin = parseDesignEntityPluginData(figma.pluginData);
    if (!entity.legacy && plugin?.id !== entity.id) {
      throw new Error(
        `Figma anchor for ${entity.id} is ${plugin?.id ? `linked to ${plugin.id}` : 'missing'}. Run link set again before planning or accepting.`,
      );
    }
    return { entity, nodeId: figma.id };
  }
  const figma = await evaluate(inspectDesignEntityCode(request.nodeId));
  const plugin = parseDesignEntityPluginData(figma.pluginData);
  const entity = resolveDesignEntity(loaded.registry, {
    id: plugin?.id,
    componentKey: figma.componentKey || figma.variantKey,
    nodeId: figma.id,
    fileKey: figma.fileKey,
  });
  if (!entity) throw new Error('Selected Figma node is not linked to a Design Entity. Run link set first.');
  if (!entity.legacy && plugin?.id !== entity.id) {
    throw new Error(`Figma anchor for ${entity.id} is missing or mismatched. Run link set again.`);
  }
  return { entity, nodeId: figma.id };
}

async function captureRoundTripState(entity, nodeId, projectRoot, adapters) {
  if (!entity.code?.path) throw new Error(`Design Entity ${entity.id} has no code source link.`);
  if (!nodeId) throw new Error(`Design Entity ${entity.id} has no Figma node link.`);
  const sourcePath = normalizeRepositoryPath(entity.code.path, projectRoot);
  const absoluteSource = resolvePath(projectRoot, sourcePath);
  const readSource = adapters.readSource || ((path) => readFileSync(path, 'utf8'));
  let content;
  try { content = await readSource(absoluteSource); } catch (error) {
    throw new Error(`Cannot read code source ${sourcePath}: ${error.message}`);
  }
  const rawSnapshot = await adapters.evaluate(buildSnapshotEval({ nodeId }));
  if (rawSnapshot?.error === 'NOT_FOUND') throw new Error(`Figma node not found: ${nodeId}`);
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (entity.figma?.fileKey && snapshot.fileKey && entity.figma.fileKey !== snapshot.fileKey) {
    throw new Error(
      `Design Entity ${entity.id} belongs to Figma file ${entity.figma.fileKey}, but command targeted ${snapshot.fileKey}.`,
    );
  }
  return {
    code: fingerprintCodeSource({
      path: sourcePath, exportName: entity.code.export || null, content,
    }),
    figma: fingerprintFigmaSnapshot(snapshot),
  };
}

function discoverProjectFiles(projectRoot, project = {}) {
  const roles = {
    designDoc: [project.designDoc, 'DESIGN.md', 'design/DESIGN.md'],
    tokens: [project.tokens, 'design/tokens.json', 'tokens.json'],
  };
  const found = {};
  for (const [role, candidates] of Object.entries(roles)) {
    for (const candidate of candidates.filter(Boolean)) {
      let relative;
      try { relative = normalizeRepositoryPath(candidate, projectRoot); } catch { continue; }
      if (relative && existsSync(resolvePath(projectRoot, relative))) {
        found[role] = relative;
        break;
      }
    }
  }
  return found;
}

function argvOption(args, name) {
  const direct = args.indexOf(name);
  if (direct !== -1) return args[direct + 1];
  const combined = args.find((arg) => arg.startsWith(`${name}=`));
  return combined ? combined.slice(name.length + 1) : undefined;
}

const LINK_VALUE_OPTIONS = new Set([
  '--manifest', '--kind', '--source', '--export', '--story', '--design-doc', '--tokens',
  '--compare', '--max-diff',
]);
function argvPositionals(args) {
  const values = [];
  for (let index = 2; index < args.length; index++) {
    const arg = args[index];
    if (LINK_VALUE_OPTIONS.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    values.push(arg);
  }
  return values;
}

/** Adapter helper for the bounded figma_run command surface. */
export function designLinkRequestFromArgv(args) {
  if (!Array.isArray(args) || args[0] !== 'link') throw new Error('Expected a link command.');
  const action = args[1];
  const manifestPath = argvOption(args, '--manifest');
  const positional = argvPositionals(args);
  if (!manifestPath) throw new Error('Design Link Registry path is required.');
  if (action === 'set') {
    return {
      action, nodeId: positional[0], entityId: positional[1], manifestPath,
      kind: argvOption(args, '--kind'), source: argvOption(args, '--source'),
      exportName: argvOption(args, '--export'), storyId: argvOption(args, '--story'),
    };
  }
  if (action === 'inspect') return { action, nodeId: positional[0], manifestPath };
  if (action === 'list') return { action, manifestPath };
  if (action === 'configure') {
    return {
      action, manifestPath,
      designDoc: argvOption(args, '--design-doc'), tokens: argvOption(args, '--tokens'),
    };
  }
  if (['status', 'accept', 'context'].includes(action)) {
    return {
      action, entityId: positional[0], manifestPath,
      ...(action === 'accept' ? {
        comparePath: argvOption(args, '--compare'),
        maxDiff: argvOption(args, '--max-diff'),
      } : {}),
    };
  }
  throw new Error(`Unknown Design Link action: ${action || '(missing)'}`);
}

/** Infer the entity's recorded file without widening the Figma Target Context. */
export function designLinkFileKeyFromArgv(args) {
  if (!Array.isArray(args) || !args[1] || args.includes('--help') || args.includes('-h')) return null;
  const request = designLinkRequestFromArgv(args);
  if (!request.entityId || !['set', 'status', 'accept', 'context'].includes(request.action)) return null;
  const loaded = readDesignLinkRegistry(dirname(request.manifestPath), { manifestPath: request.manifestPath });
  return resolveDesignEntity(loaded.registry, { id: request.entityId })?.figma?.fileKey || null;
}

export function formatDesignLinkResult(result) {
  if (result.action === 'status') {
    return formatRoundTripPlan(result.entity, result.plan, { baseline: result.entity.baseline });
  }
  if (result.action === 'accept') {
    return `Accepted current code and Figma state for ${result.entity.id}\n\n`
      + formatRoundTripPlan(result.entity, result.plan, { baseline: result.baseline });
  }
  if (result.action === 'context') return formatProjectDesignContext(result.context);
  if (result.action === 'list') {
    if (!result.entities.length) return `No Design Entities in ${result.path}.`;
    return result.entities.map((entity) => [
      `${entity.id}  [${entity.kind}]`,
      entity.code?.path ? `  code: ${entity.code.path}${entity.code.export ? `#${entity.code.export}` : ''}` : null,
      entity.storybook?.storyId ? `  story: ${entity.storybook.storyId}` : null,
      entity.figma?.nodeId ? `  figma: ${entity.figma.nodeId}` : null,
    ].filter(Boolean).join('\n')).join('\n\n');
  }
  if (result.action === 'configure') {
    return `Configured Project Design Context in ${result.path}\n`
      + Object.entries(result.project).map(([key, value]) => `  ${key}: ${value}`).join('\n');
  }
  if (result.action === 'inspect') {
    return [
      `${result.figma.name} (${result.figma.id})`,
      result.plugin ? `plugin: ${result.plugin.id} [${result.plugin.kind}]` : null,
      result.entity ? `${result.entity.id} [${result.entity.kind}]` : 'No Design Entity link found.',
    ].filter(Boolean).join('\n');
  }
  if (result.action === 'set') {
    return `Linked ${result.entity.id} to ${result.figma.name} (${result.figma.id})\nRegistry: ${result.path}`;
  }
  return JSON.stringify(result, null, 2);
}

/**
 * @param {{action:'set'|'inspect'|'list'|'status'|'accept'|'context'|'configure', nodeId?:string, entityId?:string,
 *          kind?:string, source?:string, exportName?:string, storyId?:string,
 *          designDoc?:string, tokens?:string,
 *          manifestPath:string}} request
 * @param {{evaluate?:(code:string)=>Promise<object>}} adapters
 */
export async function executeDesignLink(request, adapters = {}) {
  const manifestPath = request?.manifestPath;
  if (!manifestPath) throw new Error('Design Link Registry path is required.');
  const projectRoot = dirname(manifestPath);
  const loaded = readDesignLinkRegistry(projectRoot, { manifestPath });

  if (request.action === 'list') {
    return {
      action: 'list', path: loaded.path,
      entities: loaded.registry.entities || [],
      legacy: Boolean(loaded.legacyPath),
    };
  }

  if (request.action === 'configure') {
    if (!request.designDoc && !request.tokens) {
      throw new Error('link configure requires --design-doc and/or --tokens.');
    }
    const registry = {
      ...loaded.writableRegistry,
      project: {
        ...(loaded.writableRegistry.project || {}),
        ...(request.designDoc ? { designDoc: normalizeRepositoryPath(request.designDoc, projectRoot) } : {}),
        ...(request.tokens ? { tokens: normalizeRepositoryPath(request.tokens, projectRoot) } : {}),
      },
    };
    writeDesignLinkRegistry(loaded.path, registry);
    return { action: 'configure', path: loaded.path, project: registry.project };
  }

  if (typeof adapters.evaluate !== 'function') {
    throw new Error('Design Link command requires a Figma evaluate adapter.');
  }

  if (request.action === 'inspect') {
    const figma = await adapters.evaluate(inspectDesignEntityCode(request.nodeId));
    const plugin = parseDesignEntityPluginData(figma.pluginData);
    const entity = resolveDesignEntity(loaded.registry, {
      id: plugin?.id,
      componentKey: figma.componentKey || figma.variantKey,
      nodeId: figma.id,
      fileKey: figma.fileKey,
    });
    return { action: 'inspect', path: loaded.path, figma: { ...figma, pluginData: undefined }, plugin, entity };
  }

  if (['status', 'accept', 'context'].includes(request.action)) {
    const resolved = await liveEntity(request, loaded, adapters.evaluate);
    const state = await captureRoundTripState(resolved.entity, resolved.nodeId, projectRoot, adapters);
    const plan = planRoundTrip({
      ...state,
      baseline: resolved.entity.baseline,
    });
    if (request.action === 'status') {
      return { action: 'status', path: loaded.path, entity: resolved.entity, state, plan };
    }
    if (request.action === 'context') {
      return {
        action: 'context', path: loaded.path,
        context: projectDesignContext({
          entity: resolved.entity,
          plan,
          projectFiles: discoverProjectFiles(projectRoot, loaded.registry.project),
        }),
      };
    }
    if (resolved.entity.legacy) {
      throw new Error(`Design Entity ${resolved.entity.id} comes from legacy figma-map.json. Migrate it with link set before accepting a baseline.`);
    }
    const visual = await verifyVisualParity(request, resolved.entity, resolved.nodeId, adapters);
    const baseline = {
      ...acceptedRoundTripBaseline(state.code, state.figma),
      ...(visual ? { visual } : {}),
    };
    const registry = upsertDesignEntity(loaded.writableRegistry, {
      id: resolved.entity.id,
      kind: resolved.entity.kind,
      baseline,
    });
    writeDesignLinkRegistry(loaded.path, registry);
    return {
      action: 'accept', path: loaded.path,
      entity: resolveDesignEntity(registry, { id: resolved.entity.id }),
      baseline,
      plan: planRoundTrip({ ...state, baseline }),
    };
  }

  if (request.action !== 'set') throw new Error(`Unknown Design Link action: ${request.action}`);
  const entityId = normalizeDesignEntityId(request.entityId);
  const figma = await adapters.evaluate(setDesignEntityCode({
    nodeId: request.nodeId,
    entityId,
    kind: request.kind,
  }));
  const kind = normalizeDesignEntityKind(figma.kind);
  const registry = upsertDesignEntity({
    ...loaded.writableRegistry,
    project: {
      ...(loaded.writableRegistry.project || {}),
      ...(figma.fileKey ? { figmaFileKey: figma.fileKey } : {}),
      ...(figma.fileName ? { figmaFileName: figma.fileName } : {}),
    },
  }, {
    id: entityId,
    kind,
    code: codeLink(request, projectRoot),
    storybook: storybookLink(request),
    figma: {
      fileKey: figma.fileKey,
      nodeId: figma.id,
      componentKey: figma.componentKey,
      variantKey: figma.variantKey,
      name: figma.name,
      nodeType: figma.type,
    },
  });
  try {
    writeDesignLinkRegistry(loaded.path, registry);
  } catch (error) {
    throw new Error(
      `Figma node now carries Design Entity ${entityId}, but ${loaded.path} could not be written (${error.message}). `
      + 'Repeat the same link set command to converge both adapters.',
    );
  }
  return {
    action: 'set', path: loaded.path, entity: resolveDesignEntity(registry, { id: entityId }),
    figma: { id: figma.id, name: figma.name, type: figma.type, fileKey: figma.fileKey },
  };
}
