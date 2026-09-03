// Value-returning Command Application for simple and compound Semantic Render.
//
// JSX and explicit batches adapt into validated Semantic Render Plans.
// Commander, figma_run and figma_render share preparation,
// native/compatibility selection, bounded stages, projection and formatting.

import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { FigmaClient } from '../lib/jsx-render.js';
import {
  designEntityRegistryProjection,
  readDesignLinkRegistry,
} from '../lib/design-link-registry.js';
import {
  findRepeatedSiblings,
  formatReuseWarning,
  matchInventory,
  namedContainers,
} from '../lib/render-lint.js';
import { cachedInventoryCode, projectComponentInventory } from '../lib/component-inventory.js';
import { inspectStructuredRenderPlan } from '../lib/structured-render-executor.js';
import {
  assertSemanticRenderOutcome,
  projectSemanticRenderBatchOutcome,
  projectSemanticRenderFailureOutcome,
  projectSemanticRenderOutcome,
} from '../lib/semantic-render-outcome.js';
import {
  SEMANTIC_RENDER_DEVICE_PRESETS,
  semanticCompoundRenderRequestFromArgv,
  semanticRenderImageReferences,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderRequestFromArgv,
} from './semantic-render-request.js';
import { IMAGE_HARD_LIMIT, IMAGE_WARN_LIMIT, inboundImageCeilingGuidance } from '../lib/image-file.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../lib/protocol-contract.js';
import { rasterDimensions, rasterKind } from '../lib/raster-dimensions.js';
import { materializeRemoteRenderImage } from '../lib/remote-render-assets.js';
import { semanticRootResizeProbeCode } from '../lib/semantic-resize-probe.js';
import {
  assertMultiScreenReuseAcceptance,
  buildMultiScreenReusePlan,
  completeMultiScreenReuseReport,
} from '../lib/multi-screen-reuse-plan.js';
import { decodeVerificationPngBase64 } from './verification-artifact.js';
import { verificationPngExportCode } from './verification-settle.js';

export { semanticRenderArgvFromRequest } from './semantic-render-request.js';
export { semanticRenderOutcomeCode } from '../lib/semantic-render-outcome.js';

const APPLICATION_ID = 'render';
const APPLICATION_IDS = new Set([APPLICATION_ID, 'render-batch']);
const PREPARED_RENDER_REQUESTS = new WeakSet();
const PREPARED_COMPOUND_RENDER_REQUESTS = new WeakSet();
const MAX_EVIDENCE_ITEMS = 100;
const MAX_EVIDENCE_STRING_CODE_POINTS = 512;

/** @typedef {{tone:string,text:string,marker?:string,markerTone?:string}} SemanticRenderRow */

function boundedText(value, max = MAX_EVIDENCE_STRING_CODE_POINTS) {
  const points = Array.from(String(value ?? ''));
  return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join('')}…` : points.join('');
}

function compatibilityDegradations(supportOrSupports) {
  const compound = Array.isArray(supportOrSupports);
  const supports = compound ? supportOrSupports : [supportOrSupports];
  const degradations = [];
  for (let index = 0; index < supports.length; index++) {
    for (const problem of supports[index]?.problems || []) {
      if (degradations.length >= MAX_EVIDENCE_ITEMS) break;
      const text = boundedText(problem);
      const separator = text.indexOf(': ');
      let path = separator > 0 ? text.slice(0, separator) : 'root';
      const fact = separator > 0 ? text.slice(separator + 2) : text;
      if (compound) {
        path = path === 'root'
          ? `root[${index}]`
          : path.startsWith('root.')
            ? `root[${index}]${path.slice(4)}`
            : `root[${index}].${path}`;
      }
      degradations.push(Object.freeze({
        kind: 'compatibility-fallback',
        path: boundedText(path),
        fact: boundedText(fact),
        disposition: 'generated-eval-compatibility',
      }));
    }
  }
  return degradations;
}

function preflightError(message) {
  return Object.assign(new Error(message), {
    kind: 'validation',
    phase: 'request-validation',
    outcome: 'not-dispatched',
  });
}

/** The render-plan options exactly as the native executor receives them. */
function nativeRenderOptions(request) {
  return {
    smart: request.placement.smart,
    x: request.placement.x,
    y: request.placement.y,
    // Only a named target travels; a Design render's payload stays exactly
    // what it was before Slides became reachable.
    ...(request.placement.slide == null ? {} : { slide: request.placement.slide }),
    materializeResources: request.resourcePolicy.materializeGenerated,
  };
}

/** The batch options exactly as the native compound executor receives them. */
function nativeCompoundOptions(request) {
  return {
    gap: request.layout.gap,
    vertical: request.layout.direction === 'col',
    smart: request.placement.smart,
    x: request.placement.x,
    y: request.placement.y,
    materializeResources: request.resourcePolicy.materializeGenerated,
  };
}

// Every embedded image rides inside one protocol value, so the transport's
// limit applies to their sum, not to each file. Measure the payload the
// executor will send -- serialized the way the protocol validator serializes
// it, against the same MAX_PROTOCOL_VALUE_BYTES -- and refuse here, before
// Plugin readiness, with the command's own guidance rather than the
// transport's error afterwards. The measure is inlined rather than exported
// from protocol-contract.js because that module is part of the Plugin
// compatibility fingerprint, and a preflight is not a protocol change.
function renderPayloadByteLength(payload) {
  try {
    const serialized = JSON.stringify(payload);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
}

function assertRenderPayloadFits(payload) {
  const bytes = renderPayloadByteLength(payload);
  if (bytes === null) throw preflightError('Semantic Render produced a payload that cannot be serialized.');
  if (bytes > MAX_PROTOCOL_VALUE_BYTES) {
    throw preflightError(
      `Semantic Render payload is ${bytes} bytes serialized, over the ${MAX_PROTOCOL_VALUE_BYTES} byte `
      + 'protocol limit. Embedded images ride inside the plan as base64 (4/3 of their file size) and '
      + 'count together; downscale or drop images until the plan fits.',
    );
  }
}

function preflightCount(value, label, max = 20_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw preflightError(`Semantic Render produced invalid ${label} diagnostics.`);
  }
  return value;
}

function devicePreset(jsx, presetName) {
  if (!presetName) return { jsx, note: null };
  const [width, height] = SEMANTIC_RENDER_DEVICE_PRESETS[presetName];
  const match = jsx.match(/<Frame\b([^>]*)>/);
  if (!match) return { jsx, note: null };
  const props = match[1];
  const hasWidth = /\b(?:w|width)=/.test(props);
  const hasHeight = /\b(?:h|height)=/.test(props);
  if (hasWidth && hasHeight) {
    return { jsx, note: `preset ${presetName} (${width}×${height}) ignored — the JSX sets explicit w/h` };
  }
  const injected = `${hasWidth ? '' : ` w="${width}"`}${hasHeight ? '' : ` h="${height}"`}`;
  return {
    jsx: jsx.replace(/<Frame\b/, `<Frame${injected} `),
    note: `preset ${presetName}: root frame ${width}×${height}`,
  };
}

function repeatedStructureWarnings(client, jsx) {
  try {
    const open = String(jsx).match(/<Frame\s+([^>]*)>/);
    if (!open) return [];
    const props = client.parseProps(open[1]);
    const children = client.parseChildren(
      client.extractContent(String(jsx).slice(open.index + open[0].length), 'Frame'),
    );
    const root = { _type: 'frame', ...props, _children: children };
    const groups = [
      ...findRepeatedSiblings([root]),
      ...findRepeatedSiblings(root._children),
    ];
    return groups.map((group) => `${group.count}× the same structure${group.sampleName ? ` ("${group.sampleName}")` : ''} in one render — make it a component, then place Instance copies.`);
  } catch {
    return [];
  }
}

function compileEvidence(client, jsx, renderPlan, request, presetNote) {
  const warnings = [];
  if (presetNote) warnings.push({ tone: 'muted', text: presetNote });
  for (const warning of client.validateJsxProps(jsx)) {
    warnings.push({
      tone: 'warning',
      text: `Unknown prop "${boundedText(warning.prop)}" on <${boundedText(warning.tag)}>${warning.suggestion ? ` — did you mean "${boundedText(warning.suggestion)}"?` : ' (ignored)'}`,
    });
  }
  for (const warning of repeatedStructureWarnings(client, jsx)) {
    warnings.push({ tone: 'warning', text: warning });
  }

  const diagnostics = renderPlan.diagnostics || {};
  const layouts = diagnostics.layouts || {};
  const unclassified = diagnostics.unclassifiedFallbacks || [];
  if (unclassified.length) {
    const detail = unclassified.slice(0, 10)
      .map((finding) => `${boundedText(finding.path)}: ${boundedText(finding.fact)}`)
      .join('; ');
    throw preflightError(`Semantic Render has ${unclassified.length} unclassified structural problem(s): ${detail}`);
  }
  const pendingFontAxes = (diagnostics.classifiedFallbacks || []).filter((finding) =>
    finding.fallback === 'font.named-faces'
    && !request.approvedFallbacks.some((approval) => approval === finding.fallback
      || approval === finding.path || approval === `${finding.path}:${finding.fallback}`));
  if (pendingFontAxes.length) {
    throw preflightError('Semantic Render needs a variable-font decision; install the requested font or approve font.named-faces.');
  }
  if (diagnostics.classifiedFallbacks?.length) {
    warnings.push({ tone: 'warning', text: `${diagnostics.classifiedFallbacks.length} explicit/classified structural fallback(s).` });
  }
  if (diagnostics.unresolvedIcons?.length) {
    const names = [...new Set(diagnostics.unresolvedIcons.map((item) => boundedText(item.name)))];
    warnings.push({ tone: 'warning', text: `${diagnostics.unresolvedIcons.length} unresolved icon(s): ${names.slice(0, 20).join(', ')}.` });
  }

  return Object.freeze({
    structure: Object.freeze({
      grid: preflightCount(Number(layouts.grid || 0), 'diagnostics.layouts.grid'),
      flex: preflightCount(Number(layouts.flex || 0), 'diagnostics.layouts.flex'),
      free: preflightCount(Number(layouts.free || 0), 'diagnostics.layouts.free'),
      absolute: preflightCount(Number(diagnostics.absoluteNodes || 0), 'diagnostics.absoluteNodes'),
    }),
    warnings: Object.freeze(warnings.slice(0, MAX_EVIDENCE_ITEMS).map((warning) => Object.freeze({
      tone: warning.tone,
      text: boundedText(warning.text),
    }))),
  });
}

function assertRootIdentityStageCompatibility(request, renderPlans) {
  if (!request.stages?.componentConversion) return;
  const identified = renderPlans.find((renderPlan) => renderPlan.root.source.props.entity != null);
  if (identified) {
    throw preflightError(
      'A rendered-root screen/frame Design Entity cannot use --as-component; link a component entity in a separate render instead.',
    );
  }
}

/** Select the exact Adapter without executing the Command. */
export function semanticRenderPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Semantic Render routing requires a Command Plan created by the Capability Catalog.');
  }
  if (!plan.allowed || !APPLICATION_IDS.has(plan.id)) return 'not-render';
  const route = semanticRenderArgvRoute([...plan.argv]);
  if (route.kind === 'simple') return 'command-application';
  if (route.kind === 'compound') return 'compound-command-application';
  return route.kind === 'help' ? 'not-render' : 'commander-compatibility';
}

/** Parse JSX and prepare the exact native or generated execution decision. */
export function prepareSemanticRenderPlan(plan, adapters = {}) {
  if (semanticRenderPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the simple Semantic Render Command Application.`);
  }
  const request = semanticRenderRequestFromArgv([...plan.argv]);
  const preset = devicePreset(request.jsx, request.preset);
  const client = new FigmaClient();
  if (request.collection) client.setCollection(request.collection);
  if (request.manifest) {
    if (!adapters.workspaceIO) throw new TypeError('Semantic Render requires a WorkspaceIO adapter.');
    const registry = readDesignLinkRegistry(dirname(request.manifest), {
      manifestPath: request.manifest,
      io: adapters.workspaceIO,
    }).registry;
    client.setDesignEntityProjection(designEntityRegistryProjection(registry, {
      targetFileKey: plan.target.fileKey,
    }));
  }
  const renderPlan = client.planJSX(preset.jsx);
  assertRootIdentityStageCompatibility(request, [renderPlan]);
  assertRenderPayloadFits({ plan: renderPlan, options: nativeRenderOptions(request) });
  const evidence = compileEvidence(client, preset.jsx, renderPlan, request, preset.note);
  const support = inspectStructuredRenderPlan(renderPlan);
  const prepared = Object.freeze({ request, client, renderPlan, support, evidence, jsx: preset.jsx });
  PREPARED_RENDER_REQUESTS.add(prepared);
  return prepared;
}

/** Validate every compound root without reading files, reaching the network,
 * checking Plugin readiness, or creating a Figma mutation payload. */
export function validateCompoundSemanticRenderPlan(plan) {
  if (semanticRenderPlanRoute(plan) !== 'compound-command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the compound Semantic Render Command Application.`);
  }
  const request = semanticCompoundRenderRequestFromArgv([...plan.argv]);
  const client = new FigmaClient();
  for (const jsx of request.roots) {
    client.analyzeJSX(devicePreset(jsx, request.preset).jsx);
  }
  return request;
}

function loadCompoundIcons(directory, io) {
  if (!directory) return Object.freeze({});
  const accepted = io.authorizePath(directory, {
    access: 'read', role: 'render-icons', kind: 'directory',
  });
  const files = readdirSync(accepted.canonical);
  if (files.length > 10_000) throw preflightError('Semantic Render icon directory exceeds 10,000 entries.');
  const icons = Object.create(null);
  for (const file of files) {
    if (extname(file).toLowerCase() !== '.svg') continue;
    const full = resolve(accepted.canonical, file);
    const svg = io.readText(full, { role: 'render-icon', maxBytes: 100 * 1024 });
    icons[basename(file, extname(file))] = svg;
  }
  return Object.freeze(icons);
}

async function resolveCompoundImages(roots, io, materializeRemoteImage) {
  const images = Object.create(null);
  const references = new Map();
  const content = new Set();
  const notes = [];
  let localImageCount = 0;
  let remoteImageCount = 0;
  const assetKey = (reference, asset) => {
    const priorReference = references.get(reference);
    if (priorReference) return priorReference;
    const key = `img${Object.keys(images).length}`;
    content.add(asset.sha256);
    images[key] = asset;
    references.set(reference, key);
    return key;
  };
  const resolveValue = async (value) => {
    if (/^(?:imgref:|data:)/i.test(value)) return null;
    if (/^https?:/i.test(value)) {
      const reference = `remote:${value}`;
      const existing = references.get(reference);
      if (existing) return existing;
      const key = assetKey(reference, await materializeRemoteImage(value));
      remoteImageCount++;
      return key;
    }
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(value)) {
      throw preflightError('Semantic Render image input must be PNG, JPEG, GIF, or WEBP.');
    }
    const input = isAbsolute(value) ? value : resolve(io.roots[0], value);
    const existing = references.get(`workspace:${input}`);
    if (existing) return existing;
    const accepted = io.authorizePath(input, { access: 'read', role: 'render-image', kind: 'file' });
    const size = accepted.metadata.size;
    if (size > IMAGE_HARD_LIMIT) {
      throw preflightError(
        `Semantic Render image exceeds ${IMAGE_HARD_LIMIT} bytes (${basename(input)} is ${size} bytes). `
        + inboundImageCeilingGuidance(),
      );
    }
    const bytes = io.read(accepted.canonical, { role: 'render-image', maxBytes: IMAGE_HARD_LIMIT });
    const kind = rasterKind(bytes);
    const expected = extname(input).toLowerCase().replace(/^\.jpg$/, '.jpeg').slice(1);
    if (!kind || kind !== expected) {
      throw preflightError('Semantic Render image extension does not match its raster bytes.');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = assetKey(`workspace:${input}`, Object.freeze({
      kind: 'embedded-raster',
      name: basename(input),
      base64: bytes.toString('base64'),
      ...rasterDimensions(bytes, kind),
      sha256,
      source: Object.freeze({ kind: 'workspace', label: basename(input) }),
    }));
    localImageCount++;
    if (size > IMAGE_WARN_LIMIT) {
      notes.push(Object.freeze({
        tone: 'warning',
        text: `Render image ${key} is ${(size / 1048576).toFixed(1)} MB; downscaling will make the Plugin Bridge faster.`,
      }));
    }
    return key;
  };
  const rewritten = [];
  for (const jsx of roots) {
    const chunks = [];
    let cursor = 0;
    for (const reference of semanticRenderImageReferences(jsx)) {
      const key = await resolveValue(reference.value);
      chunks.push(
        jsx.slice(cursor, reference.start),
        key ? `${reference.attribute}="imgref:${key}"` : reference.raw,
      );
      cursor = reference.end;
    }
    chunks.push(jsx.slice(cursor));
    rewritten.push(chunks.join(''));
  }
  return Object.freeze({
    roots: Object.freeze(rewritten), images: Object.freeze(images),
    localImageCount, remoteImageCount, uniqueContent: content.size,
    notes: Object.freeze(notes),
  });
}

/** Prepare every compound root and all local/remote resources before readiness. */
export async function prepareCompoundSemanticRenderPlan(plan, adapters = {}) {
  if (semanticRenderPlanRoute(plan) !== 'compound-command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the compound Semantic Render Command Application.`);
  }
  if (!adapters.workspaceIO) throw new TypeError('Compound Semantic Render requires a WorkspaceIO adapter.');
  const request = semanticCompoundRenderRequestFromArgv([...plan.argv]);
  const materializeRemoteImage = adapters.materializeRemoteImage
    || ((input) => materializeRemoteRenderImage(input, { remainingMs: adapters.remainingMs }));
  const imagePreparation = await resolveCompoundImages(
    request.roots,
    adapters.workspaceIO,
    materializeRemoteImage,
  );
  const icons = loadCompoundIcons(request.icons, adapters.workspaceIO);
  const client = new FigmaClient();
  if (request.collection) client.setCollection(request.collection);
  client.setImageData(imagePreparation.images);
  if (Object.keys(icons).length) client.setIcons(icons);
  if (request.manifest) {
    const registry = readDesignLinkRegistry(dirname(request.manifest), {
      manifestPath: request.manifest,
      io: adapters.workspaceIO,
    }).registry;
    client.setDesignEntityProjection(designEntityRegistryProjection(registry, {
      targetFileKey: plan.target.fileKey,
    }));
  }

  const presetRoots = imagePreparation.roots.map((jsx) => devicePreset(jsx, request.preset));
  const reusePlan = buildMultiScreenReusePlan(
    client,
    presetRoots.map(({ jsx }) => jsx),
    {
      approvedFlatRepetitions: request.approvedFlatRepetitions,
      direction: request.layout.direction,
      placement: request.placement,
    },
  );
  assertMultiScreenReuseAcceptance(reusePlan);
  const renderPlans = presetRoots.map(({ jsx }) => client.planJSX(jsx));
  assertRootIdentityStageCompatibility(request, renderPlans);
  assertRenderPayloadFits({ plans: renderPlans, options: nativeCompoundOptions(request) });
  const evidence = renderPlans.map((renderPlan, index) => compileEvidence(
    client, presetRoots[index].jsx, renderPlan, request, presetRoots[index].note,
  ));
  const supports = renderPlans.map((renderPlan) => inspectStructuredRenderPlan(renderPlan));
  const notes = [
    ...imagePreparation.notes,
    ...evidence.flatMap((item, index) => item.warnings.map((warning) => Object.freeze({
      tone: warning.tone,
      text: boundedText(`root ${index + 1}: ${warning.text}`),
    }))),
  ].slice(0, MAX_EVIDENCE_ITEMS);
  const prepared = Object.freeze({
    request, client, reusePlan,
    jsxRoots: Object.freeze(presetRoots.map(({ jsx }) => jsx)),
    renderPlans: Object.freeze(renderPlans),
    supports: Object.freeze(supports),
    structures: Object.freeze(evidence.map((item) => item.structure)),
    notes: Object.freeze(notes),
    preparedAssets: Object.freeze({
      localImages: imagePreparation.localImageCount,
      iconDirectory: request.icons ? 1 : 0,
      remoteImages: imagePreparation.remoteImageCount,
      embeddedImages: request.assets.embeddedCount,
      uniqueImageContent: imagePreparation.uniqueContent,
    }),
  });
  PREPARED_COMPOUND_RENDER_REQUESTS.add(prepared);
  return prepared;
}

function compoundStage(kind, status, attempted, completed, failed = 0, handles = [], artifacts = [], verification = undefined) {
  return Object.freeze({
    kind, status, attempted, completed, failed, handles, artifacts,
    ...(verification === undefined ? {} : { verification }),
  });
}

function componentConversionCode(handles) {
  return `(async () => {
    const ids = ${JSON.stringify(handles)};
    const components = [];
    for (let index = 0; index < ids.length; index++) {
      try {
        const node = await figma.getNodeByIdAsync(ids[index]);
        if (!node) return { version: 1, components, failed: { index } };
        const component = figma.createComponentFromNode(node);
        components.push({ sourceId: ids[index], id: component.id, name: component.name });
      } catch (_) {
        return { version: 1, components, failed: { index } };
      }
    }
    return { version: 1, components, failed: null };
  })()`;
}

function verificationCode(handle) {
  return `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(handle)});
    if (!node || !('exportAsync' in node)) return { version: 1, failed: true };
    const maxDimension = Math.max(node.width || 100, node.height || 100);
    const requestedScale = 1;
    const appliedScale = maxDimension > 2000 ? 2000 / maxDimension : requestedScale;
    ${verificationPngExportCode('node', 'appliedScale')}
    return { version: 1, failed: false, id: node.id,
      nodeWidth: node.width || 100, nodeHeight: node.height || 100,
      requestedScale, appliedScale,
      base64: figma.base64Encode(bytes) };
  })()`;
}

function stageFailure(kind, message = `${kind} failed`) {
  return Object.assign(new Error(message), {
    kind: 'plugin-result', phase: 'plugin-response',
    outcome: 'unknown-after-dispatch', dispatchState: 'failed',
  });
}

function compatibilityPlanWithPlacement(plan, placement) {
  const x = placement?.x === null || placement?.x === undefined
    ? (placement?.smart === false ? 0 : null)
    : placement.x;
  const y = placement?.y === null || placement?.y === undefined ? null : placement.y;
  if (x === null && y === null) return plan;
  const positioned = JSON.parse(JSON.stringify(plan));
  positioned.root.source.props = {
    ...positioned.root.source.props,
    ...(x === null ? {} : { x }),
    ...(y === null ? {} : { y }),
  };
  return positioned;
}

function validateComponentResult(value, expectedHandles) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw stageFailure('component-conversion', 'Component conversion returned an invalid result.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || bytes > 128 * 1024
    || value.version !== 1 || !Array.isArray(value.components)
    || value.components.length > expectedHandles.length
    || !Object.hasOwn(value, 'failed')
    || Object.keys(value).some((key) => !['version', 'components', 'failed'].includes(key))) {
    throw stageFailure('component-conversion', 'Component conversion returned an invalid result.');
  }
  const converted = [];
  for (let index = 0; index < value.components.length; index++) {
    const item = value.components[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !['sourceId', 'id', 'name'].includes(key))
      || item.sourceId !== expectedHandles[index]
      || typeof item.id !== 'string' || item.id.length > 128
      || !/^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/.test(item.id)
      || (item.name !== undefined && (typeof item.name !== 'string'
        || Array.from(item.name).length > 512))) {
      throw stageFailure('component-conversion', 'Component conversion returned invalid handle evidence.');
    }
    converted.push(item.id);
  }
  if (value.failed === null) {
    if (converted.length !== expectedHandles.length) {
      throw stageFailure('component-conversion', 'Component conversion omitted a result.');
    }
    return Object.freeze({ converted: Object.freeze(converted), failedIndex: null });
  }
  if (!value.failed || !Number.isSafeInteger(value.failed.index)
    || value.failed.index !== converted.length || value.failed.index >= expectedHandles.length
    || Object.keys(value.failed).some((key) => key !== 'index')) {
    throw stageFailure('component-conversion', 'Component conversion returned inconsistent partial evidence.');
  }
  return Object.freeze({ converted: Object.freeze(converted), failedIndex: value.failed.index });
}

function validateResizeResult(value, handle) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw stageFailure('resize-probe', 'Resize probe returned an invalid result.'); }
  if (bytes > 128 * 1024 || !value || value.version !== 1 || typeof value.passed !== 'boolean'
    || value.root?.id !== handle || !value.summary || typeof value.summary !== 'object') {
    throw stageFailure('resize-probe', 'Resize probe returned invalid bounded evidence.');
  }
  return value.passed;
}

function validateVerificationResult(value, handle) {
  if (!value || value.version !== 1 || value.failed !== false || value.id !== handle
    || !Number.isFinite(value.nodeWidth) || value.nodeWidth < 0 || value.nodeWidth > 1_000_000
    || !Number.isFinite(value.nodeHeight) || value.nodeHeight < 0 || value.nodeHeight > 1_000_000
    || value.requestedScale !== 1
    || !Number.isFinite(value.appliedScale) || value.appliedScale <= 0 || value.appliedScale > 1) {
    throw stageFailure('verification', 'Verification returned invalid bounded image evidence.');
  }
  try {
    const image = decodeVerificationPngBase64(value.base64);
    return Object.freeze({
      ...value,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      scale: value.appliedScale,
    });
  } catch {
    throw stageFailure('verification', 'Verification returned invalid bounded PNG evidence.');
  }
}

/** Execute one prepared compound write and every requested follow-up exactly once. */
export async function executePreparedCompoundSemanticRender(prepared, adapters = {}) {
  if (!PREPARED_COMPOUND_RENDER_REQUESTS.has(prepared)) {
    throw new TypeError('Compound Semantic Render execution requires a prepared request from this Application.');
  }
  if (typeof adapters.renderPlanBatch !== 'function') {
    throw new TypeError('Compound Semantic Render requires a renderPlanBatch adapter.');
  }
  if (!prepared.supports.every((support) => support.supported)
    && typeof adapters.evaluate !== 'function') {
    throw new TypeError('Unmigrated compound Semantic Render facts require an evaluate compatibility adapter.');
  }
  if (prepared.request.stages.verification && typeof adapters.writeVerification !== 'function') {
    throw new TypeError('Compound Semantic Render verification requires a writeVerification adapter.');
  }
  const stages = [];
  stages.push(prepared.request.roots.length > 1
    ? compoundStage('reuse-preflight', 'completed', prepared.request.roots.length, prepared.request.roots.length)
    : compoundStage('reuse-preflight', 'skipped', 0, 0));
  let createdComponents = 0;
  const reuseReport = () => completeMultiScreenReuseReport(prepared.reusePlan, { createdComponents });
  const assetCount = prepared.preparedAssets.localImages + prepared.preparedAssets.iconDirectory
    + prepared.preparedAssets.remoteImages + prepared.preparedAssets.embeddedImages;
  stages.push(compoundStage(
    'asset-preparation', assetCount ? 'completed' : 'skipped',
    assetCount ? Math.min(prepared.request.roots.length, 100) : 0,
    assetCount ? Math.min(prepared.request.roots.length, 100) : 0,
  ));
  const attachFailure = (error, executor, partialOutcome = null) => {
    const failure = /** @type {Error & { semanticRenderOutcome?: any }} */ (
      error instanceof Error ? error : new Error(String(error || 'Compound Semantic Render failed'))
    );
    if (!failure.semanticRenderOutcome) {
      failure.semanticRenderOutcome = projectSemanticRenderFailureOutcome(failure, {
        executor, structure: prepared.structures, partialOutcome, stages, degradations,
        reuse: reuseReport(),
      });
    }
    return failure;
  };

  const options = nativeCompoundOptions(prepared.request);
  let raw;
  let executor;
  let compatibilityReason = null;
  let degradations = [];
  if (prepared.supports.every((support) => support.supported)) {
    try {
      raw = await adapters.renderPlanBatch(prepared.renderPlans, options);
      executor = 'structured-batch-v1';
    } catch (error) {
      stages.push(compoundStage('render', 'failed', prepared.renderPlans.length, 0, 1));
      throw attachFailure(error, 'structured-batch-v1');
    }
  } else {
    compatibilityReason = `Native compound preflight unsupported: ${prepared.supports
      .flatMap((support) => support.problems || []).slice(0, 5).map((problem) => boundedText(problem)).join('; ')}`;
    degradations = compatibilityDegradations(prepared.supports);
  }
  if (compatibilityReason) {
    executor = 'generated-eval-batch-compatibility';
    try {
      const code = await prepared.client.compileRenderPlans(prepared.renderPlans, options);
      raw = await adapters.evaluate(code);
    } catch (error) {
      stages.push(compoundStage('render', 'failed', prepared.renderPlans.length, 0, 1));
      throw attachFailure(error, executor);
    }
  }
  const notices = [...prepared.notes];
  if (compatibilityReason) notices.push(Object.freeze({ tone: 'warning', text: boundedText(compatibilityReason) }));
  stages.push(compoundStage('render', 'completed', prepared.renderPlans.length, prepared.renderPlans.length));
  stages.push(compoundStage('placement', 'completed', prepared.renderPlans.length, prepared.renderPlans.length));

  let outcome;
  try {
    outcome = projectSemanticRenderBatchOutcome(raw, {
      executor, structures: prepared.structures, notices, stages, degradations,
      reuse: reuseReport(),
    });
  } catch (error) {
    stages.splice(-2, 2, compoundStage('render', 'failed', prepared.renderPlans.length, 0, 1));
    throw attachFailure(error, executor);
  }
  let handles = outcome.roots.map((root) => root.handle);
  if (outcome.structure.live) {
    stages.push(compoundStage(
      'structural-gate', outcome.structure.live.passed ? 'completed' : 'completed-with-findings',
      handles.length, handles.length, 0, handles,
    ));
  } else {
    stages.push(compoundStage('structural-gate', 'skipped', 0, 0));
  }

  if (prepared.request.stages.componentConversion) {
    let converted;
    try {
      converted = validateComponentResult(await adapters.evaluate(componentConversionCode(handles)), handles);
    } catch (error) {
      stages.push(compoundStage('component-conversion', 'failed', handles.length, 0, 1));
      throw attachFailure(error, executor, outcome);
    }
    const nextHandles = [...converted.converted, ...handles.slice(converted.converted.length)];
    if (converted.failedIndex !== null) {
      createdComponents = converted.converted.length;
      stages.push(compoundStage(
        'component-conversion', 'failed', converted.failedIndex + 1,
        converted.converted.length, 1, [...converted.converted],
      ));
      const partial = projectSemanticRenderBatchOutcome(raw, {
        executor, structures: prepared.structures, notices, stages, rootHandles: nextHandles,
        degradations, reuse: reuseReport(),
      });
      throw attachFailure(stageFailure('component-conversion'), executor, partial);
    }
    handles = nextHandles;
    createdComponents = handles.length;
    stages.push(compoundStage(
      'component-conversion', 'completed', handles.length, handles.length, 0, handles,
    ));
  } else {
    stages.push(compoundStage('component-conversion', 'skipped', 0, 0));
  }

  if (prepared.request.stages.resizeProbe !== null) {
    let findings = 0;
    for (let index = 0; index < handles.length; index++) {
      try {
        if (!validateResizeResult(
          await adapters.evaluate(semanticRootResizeProbeCode(handles[index], prepared.request.stages.resizeProbe)),
          handles[index],
        )) findings++;
      } catch (error) {
        stages.push(compoundStage('resize-probe', 'failed', index + 1, index, 1, handles.slice(0, index)));
        const partial = projectSemanticRenderBatchOutcome(raw, {
          executor, structures: prepared.structures, notices, stages, rootHandles: handles,
          degradations, reuse: reuseReport(),
        });
        throw attachFailure(error, executor, partial);
      }
    }
    stages.push(compoundStage(
      'resize-probe', findings ? 'completed-with-findings' : 'completed',
      handles.length, handles.length, 0, handles,
    ));
  } else {
    stages.push(compoundStage('resize-probe', 'skipped', 0, 0));
  }

  if (prepared.request.stages.verification) {
    const artifacts = [];
    const verification = [];
    for (let index = 0; index < handles.length; index++) {
      try {
        const verified = validateVerificationResult(await adapters.evaluate(verificationCode(handles[index])), handles[index]);
        const artifact = await adapters.writeVerification({
          index, handle: handles[index], width: verified.width, height: verified.height, bytes: verified.bytes,
        });
        if (typeof artifact !== 'string' || !artifact || Array.from(artifact).length > 512) {
          throw stageFailure('verification', 'Verification artifact Adapter returned an invalid path.');
        }
        artifacts.push(artifact);
        verification.push(Object.freeze({
          artifact,
          width: verified.width,
          height: verified.height,
          pixelWidth: verified.width,
          pixelHeight: verified.height,
          nodeWidth: verified.nodeWidth,
          nodeHeight: verified.nodeHeight,
          requestedScale: verified.requestedScale,
          appliedScale: verified.appliedScale,
          scale: verified.scale,
        }));
      } catch (error) {
        stages.push(compoundStage('verification', 'failed', index + 1, index, 1, handles.slice(0, index), artifacts, verification));
        const partial = projectSemanticRenderBatchOutcome(raw, {
          executor, structures: prepared.structures, notices, stages, rootHandles: handles,
          degradations, reuse: reuseReport(),
        });
        throw attachFailure(error, executor, partial);
      }
    }
    stages.push(compoundStage('verification', 'completed', handles.length, handles.length, 0, handles, artifacts, verification));
  } else {
    stages.push(compoundStage('verification', 'skipped', 0, 0));
  }

  if (typeof adapters.inspectInventory === 'function') {
    try {
      const names = namedContainers(prepared.jsxRoots);
      if (names.length) {
        const inventory = projectComponentInventory(
          await adapters.inspectInventory(cachedInventoryCode(true)),
        );
        for (const finding of matchInventory(names, inventory).slice(0, 20)) {
          notices.push(Object.freeze({ tone: 'warning', text: boundedText(`reuse: ${formatReuseWarning(finding)}`) }));
        }
      }
    } catch {}
  }
  return projectSemanticRenderBatchOutcome(raw, {
    executor, structures: prepared.structures,
    notices: notices.slice(0, MAX_EVIDENCE_ITEMS), stages, rootHandles: handles, degradations,
    reuse: reuseReport(),
  });
}

export async function executeCompoundSemanticRenderPlan(plan, adapters = {}) {
  return executePreparedCompoundSemanticRender(
    await prepareCompoundSemanticRenderPlan(plan, adapters), adapters,
  );
}

/** Execute one prepared write, with compatibility only from proven preflight. */
export async function executePreparedSemanticRender(prepared, adapters = {}) {
  if (!PREPARED_RENDER_REQUESTS.has(prepared)) {
    throw new TypeError('Semantic Render execution requires a prepared request from this Application.');
  }
  if (typeof adapters.renderPlan !== 'function') {
    throw new TypeError('Semantic Render requires a renderPlan adapter.');
  }
  if (!prepared.support.supported && typeof adapters.evaluate !== 'function') {
    throw new TypeError('Unmigrated Semantic Render facts require an evaluate compatibility adapter.');
  }

  let raw;
  let executor;
  let compatibilityReason = null;
  let degradations = [];
  const attachFailureOutcome = (error, failedExecutor) => {
    /** @type {Error & {semanticRenderOutcome?: unknown}} */
    const failure = error instanceof Error ? error : new Error(String(error || 'Semantic Render failed'));
    if (!failure.semanticRenderOutcome) {
      const outcome = projectSemanticRenderFailureOutcome(failure, {
        executor: failedExecutor,
        structure: prepared.evidence.structure,
        degradations,
      });
      try {
        failure.semanticRenderOutcome = outcome;
      } catch {
        /** @type {Error & {semanticRenderOutcome?: unknown,kind?:unknown,phase?:unknown,outcome?:unknown,dispatchState?:unknown,mutationReport?:unknown}} */
        const wrapped = new Error(failure.message, { cause: failure });
        for (const key of ['kind', 'phase', 'outcome', 'dispatchState', 'mutationReport']) {
          if (key in failure) wrapped[key] = failure[key];
        }
        wrapped.semanticRenderOutcome = outcome;
        return wrapped;
      }
    }
    return failure;
  };
  if (prepared.support.supported) {
    try {
      raw = await adapters.renderPlan(prepared.renderPlan, nativeRenderOptions(prepared.request));
      executor = 'structured-v1';
    } catch (error) {
      throw attachFailureOutcome(error, 'structured-v1');
    }
  } else {
    compatibilityReason = `Native preflight unsupported: ${prepared.support.problems.slice(0, 5).map((problem) => boundedText(problem)).join('; ')}`;
    degradations = compatibilityDegradations(prepared.support);
  }

  if (compatibilityReason) {
    executor = 'generated-eval-compatibility';
    try {
      const code = await prepared.client.compileRenderPlan(
        compatibilityPlanWithPlacement(prepared.renderPlan, prepared.request.placement),
        { materializeResources: prepared.request.resourcePolicy.materializeGenerated },
      );
      raw = await adapters.evaluate(code);
    } catch (error) {
      throw attachFailureOutcome(error, executor);
    }
  }
  const warnings = [...prepared.evidence.warnings];
  if (compatibilityReason) warnings.push(Object.freeze({ tone: 'warning', text: boundedText(compatibilityReason) }));

  // Validate the untrusted post-dispatch response before any advisory read.
  try {
    projectSemanticRenderOutcome(raw, {
      executor,
      structure: prepared.evidence.structure,
      notices: warnings,
      degradations,
    });
  } catch (error) {
    throw attachFailureOutcome(error, executor);
  }

  if (typeof adapters.inspectInventory === 'function') {
    try {
      const names = namedContainers([prepared.jsx]);
      if (names.length) {
        const inventory = projectComponentInventory(
          await adapters.inspectInventory(cachedInventoryCode(true)),
        );
        for (const finding of matchInventory(names, inventory).slice(0, 20)) {
          warnings.push(Object.freeze({ tone: 'warning', text: boundedText(`reuse: ${formatReuseWarning(finding)}`) }));
        }
      }
    } catch {
      // Reuse lint is advisory and read-only; it must never turn a completed
      // canvas write into an ambiguous failure.
    }
  }

  try {
    return projectSemanticRenderOutcome(raw, {
      executor,
      structure: prepared.evidence.structure,
      notices: warnings.slice(0, MAX_EVIDENCE_ITEMS),
      degradations,
    });
  } catch (error) {
    throw attachFailureOutcome(error, executor);
  }
}

/** Convenience Interface for tests and Adapters without a readiness phase. */
export async function executeSemanticRenderPlan(plan, adapters = {}) {
  const prepared = prepareSemanticRenderPlan(plan, adapters);
  return executePreparedSemanticRender(prepared, adapters);
}

export function semanticRenderResultRows(result) {
  const outcome = assertSemanticRenderOutcome(result);
  if (outcome.status === 'failed') throw new TypeError('Semantic Render formatter cannot format a failed Outcome as success.');
  const resources = outcome.resources;
  const structuralReport = outcome.structure.live;
  /** @type {SemanticRenderRow[]} */
  const rows = [{
    tone: 'muted',
    text: `JSX structure: ${outcome.structure.planned.grid} Grid, ${outcome.structure.planned.flex} Auto Layout, ${outcome.structure.planned.free} explicit free, ${outcome.structure.planned.absolute} absolute`,
  }];
  rows.push(...outcome.notices.map((notice) => ({ tone: notice.tone, text: notice.text })));
  for (const root of outcome.roots) {
    rows.push({ tone: 'success', marker: '✓', markerTone: 'success', text: `Rendered: ${root.handle}` });
    if (root.name) rows.push({ tone: 'muted', text: `name: ${root.name}` });
    if (root.designEntity) {
      rows.push({ tone: 'muted', text: `Design Entity: ${root.designEntity.id} (${root.designEntity.kind}) → ${root.designEntity.nodeId}` });
    }
  }
  if (outcome.roots.length > 1) rows.push({ tone: 'success', text: `${outcome.roots.length} roots created` });
  if (outcome.reuse) {
    const summary = outcome.reuse.summary;
    rows.push({
      tone: summary.approvedFlatRepetitions ? 'warning' : 'muted',
      text: `component reuse: ${summary.reusedComponents} component entities, ${summary.reusedInstances} instances, ${summary.createdComponents} components created, ${summary.approvedFlatRepetitions} approved flat repetition(s)`,
    });
  }
  rows.push({
    tone: outcome.executor.kind.startsWith('structured') ? 'muted' : 'warning',
    text: `executor: ${outcome.executor.kind.startsWith('structured')
      ? `Semantic Render Plan v${outcome.executor.version}${outcome.executor.kind === 'structured-batch' ? ' batch' : ''}`
      : 'generated eval compatibility'}`,
  });
  for (const stage of outcome.stages || []) {
    if (stage.status === 'skipped') continue;
    const tone = stage.status === 'completed' ? 'muted'
      : stage.status === 'completed-with-findings' ? 'warning' : 'error';
    rows.push({
      tone,
      text: `${stage.kind}: ${stage.status} — ${stage.completed}/${stage.attempted} completed${stage.failed ? `, ${stage.failed} failed` : ''}`,
    });
    if (stage.artifacts.length) rows.push({ tone: 'muted', text: `${stage.kind} artifacts: ${stage.artifacts.join(', ')}` });
    for (const evidence of stage.verification || []) {
      rows.push({
        tone: 'muted',
        text: `verification raster: ${evidence.pixelWidth}×${evidence.pixelHeight}px; node: ${evidence.nodeWidth}×${evidence.nodeHeight}; scale requested ${evidence.requestedScale}, applied ${evidence.appliedScale}`,
      });
    }
  }
  if (structuralReport) {
    const summary = structuralReport.summary;
    const detail = `${summary.nodes} nodes, ${summary.grids} Grid, ${summary.autoLayouts} Auto Layout, ${summary.freeLayouts} free, ${summary.instances} instances, ${summary.absoluteNodes} absolute`;
    rows.push({
      tone: structuralReport.passed ? 'muted' : 'error',
      text: `live structural audit: ${structuralReport.passed ? 'PASS' : `FAIL — ${structuralReport.mismatchCount} mismatch(es)`} — ${detail}`,
    });
    if (!structuralReport.passed) {
      for (const finding of structuralReport.mismatches.slice(0, 5)) {
        rows.push({ tone: 'error', text: `${finding.path}: ${finding.fact}; expected ${finding.expected}, got ${finding.actual}` });
      }
    }
  }
  if (resources.unresolvedVariables.length) {
    rows.push({ tone: 'warning', text: `${resources.unresolvedVariables.length} unresolved variable reference(s): ${resources.unresolvedVariables.join(', ')}. The affected properties did not retain their requested Variable bindings; inspect variables with figma_run ["var","list"].` });
  }
  if (resources.variableReport) {
    const report = resources.variableReport;
    rows.push({ tone: 'muted', text: `variable report: ${report.references} reference(s), ${report.reused} reused, ${report.created} created, ${report.bound} bound, ${report.literal} literal, ${report.ambiguous} ambiguous, ${report.unsupported} unsupported` });
    if (report.literal) {
      rows.push({
        tone: 'muted',
        text: `${report.literal} generated literal binding candidate(s) stayed literal; exact values were preserved.`,
      });
    }
    const unresolvedGenerated = report.ambiguous + report.unsupported;
    if (unresolvedGenerated) rows.push({
      tone: 'warning',
      text: `${unresolvedGenerated} generated binding candidate(s) stayed unbound because reuse was ambiguous or incompatible.`,
    });
  }
  if (resources.textStyleReport) {
    const report = resources.textStyleReport;
    rows.push({ tone: 'muted', text: `Text Style report: ${report.references} reference(s), ${report.reused} reused, ${report.created} created, ${report.bound} bound, ${report.literal} literal` });
    if (report.literal) rows.push({
      tone: 'muted',
      text: `${report.literal} unmatched typography candidate(s) stayed literal; no parallel Text Style was created.`,
    });
  }
  if (resources.motionReport) {
    const report = resources.motionReport;
    if (report.tracks) rows.push({ tone: 'success', text: `Motion: ${report.tracks} native keyframe track(s) on ${report.nodes} layer(s) from captured CSS animations; timeline ${report.timelineDuration ?? report.duration}s.` });
    if (report.skipped.length) rows.push({ tone: 'warning', text: `Motion skipped on ${report.skipped.length} layer(s) that cannot take keyframe tracks: ${report.skipped.join(', ')}` });
    if (report.failures.length) rows.push({ tone: 'warning', text: `Motion rejected by Figma on ${report.failures.length} track(s): ${report.failures.join('; ')}` });
  }
  if (resources.fallbackAnnotationReport?.requested) {
    const report = resources.fallbackAnnotationReport;
    rows.push({ tone: report.unsupported ? 'warning' : 'muted', text: `fallback annotations: ${report.applied} added, ${report.deduplicated} already present, ${report.unsupported} unsupported` });
  }
  if (resources.createdVariables.length) rows.push({ tone: 'success', text: `${resources.createdVariables.length} variable(s) created and bound: ${resources.createdVariables.join(', ')}` });
  if (resources.createdTextStyles.length) rows.push({ tone: 'success', text: `${resources.createdTextStyles.length} Text Style(s) created: ${resources.createdTextStyles.join(', ')}` });
  for (const question of resources.scopeQuestions) {
    rows.push({ tone: 'warning', text: `variable scope decision: ${question.collection ? `${question.collection}/` : ''}${question.name} (${question.resolvedType}); choices: ${question.allowedScopes.join(', ')}` });
    rows.push({ tone: 'muted', text: question.question });
  }
  if (outcome.overflow) rows.push({ tone: 'warning', text: `Content overflows the fixed frame height by ${outcome.overflow.pixels}px; shrink a child or raise the frame height.` });
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function formatSemanticRenderResult(result) {
  return semanticRenderResultRows(result)
    .map((row) => row.marker ? `${row.marker} ${row.text}` : row.text)
    .join('\n');
}
