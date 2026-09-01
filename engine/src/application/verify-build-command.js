// Repository verification Command Application with an optional bounded Figma
// reference read. Workspace and Figma effects are supplied as capabilities so
// CLI and MCP execute the same authentic Plan without Commander re-entry.

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { loadImage } from '../gradient-extractor.js';
import { BROWSER_DOM_CAPTURE_LIMITS } from '../lib/browser-dom-capture.js';
import { verifyBrowserFidelityLedger } from '../lib/browser-fidelity-ledger.js';
import { diffImages, describeRegions } from '../lib/image-diff.js';
import { verifyBuild, describeMissing } from '../lib/verify-build.js';
import { parseBoundedJson } from '../lib/workspace-io.js';
import {
  parseVerifyBuildRequest,
  verifyBuildArgvFromRequest,
  verifyBuildPlanningArgvFromRequest,
} from './verify-build-request.js';

export {
  verifyBuildArgvFromRequest,
  verifyBuildPlanningArgvFromRequest,
} from './verify-build-request.js';

const APPLICATION_ID = 'verify-build';
const FETCH_MAX_DIM = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCE_BASE64_CODE_UNITS = 24 * 1024 * 1024;
const MAX_REFERENCE_NAME_CODE_UNITS = 1024;
const MAX_REPORT_CODE_UNITS = 4 * 1024 * 1024;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.turbo', '.cache',
]);
const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.sass',
  '.less', '.html', '.htm', '.vue', '.svelte', '.astro', '.md', '.mdx',
  '.json', '.svg',
]);

function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedOutput(value) {
  if (typeof value !== 'string' || value.length > MAX_REPORT_CODE_UNITS) {
    throw new Error('verify-build report exceeded its bounded output limit.');
  }
  return value;
}

export function verifyBuildPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('verify-build routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-verify-build';
}

function scanProject(root, io) {
  const manifests = [];
  const files = [];
  let entriesSeen = 0;
  const walk = (directory, depth = 0) => {
    if (depth > io.limits.nestingDepth) {
      throw new Error(`Workspace verify-build-project rejected: nesting exceeds ${io.limits.nestingDepth}.`);
    }
    const accepted = io.authorizePath(directory, {
      access: 'read', role: 'verify-build-project', kind: 'directory',
    });
    let entries;
    try { entries = readdirSync(accepted.canonical, { withFileTypes: true }); } catch { return; }
    entriesSeen += entries.length;
    if (entriesSeen > io.limits.collectionEntries) {
      throw new Error(`Workspace verify-build-project rejected: collection exceeds ${io.limits.collectionEntries} entries.`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(accepted.canonical, entry.name), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(accepted.canonical, entry.name);
      if (entry.name === 'assets.json') {
        try { manifests.push({ path, data: io.readJson(path, { role: 'asset-manifest' }) }); } catch {}
        continue;
      }
      if (!TEXT_EXT.has(extname(entry.name).toLowerCase())) continue;
      try {
        files.push({
          path,
          text: io.readText(path, { role: 'verify-build-source', maxBytes: MAX_FILE_BYTES }),
        });
      } catch {}
    }
  };
  walk(root);
  return { manifests, files };
}

function readManifestAssetFiles(manifests, io) {
  const seen = new Set();
  const assetFiles = [];
  for (const manifest of manifests) {
    for (const asset of manifest.data?.assets || []) {
      if (!asset?.file) continue;
      const path = join(dirname(manifest.path), asset.file);
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        assetFiles.push({
          file: asset.file,
          path,
          kind: asset.kind,
          bytes: io.read(path, { role: 'exported-asset' }),
        });
      } catch {
        // Manifest v2 digest verification reports missing physical files.
      }
    }
  }
  return assetFiles;
}

function manifestRoots(manifests) {
  const byId = new Map();
  for (const manifest of manifests) {
    const roots = manifest.data?.roots
      || (manifest.data?.root
        ? [{ id: manifest.data.root, name: manifest.data.rootName }] : []);
    for (const root of roots) {
      if (root?.id && !byId.has(root.id)) byId.set(root.id, root);
    }
  }
  return [...byId.values()];
}

function loadImageOrThrow(path, role, io) {
  const extension = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
    throw new Error(`verify-build: ${role} must be a PNG or JPEG, got "${basename(path)}".`);
  }
  try { return loadImage(path, { io }); }
  catch (error) { throw new Error(`verify-build: cannot read ${role} ${path}: ${error.message}`); }
}

export function verifyBuildDesignReferenceCode(nodeId) {
  return `(async () => {
    const clean = (value) => typeof value === 'string'
      ? value.slice(0, ${MAX_REFERENCE_NAME_CODE_UNITS}).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!node) return { error: 'Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + clean(figma.root.name) + '" — Safe Mode only reaches the file open in Figma Desktop.' };
    if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
    const maxDim = Math.max(node.width || 1, node.height || 1);
    const scale = Math.min(1, ${FETCH_MAX_DIM} / maxDim);
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    return { name: clean(node.name), scale, base64: figma.base64Encode(bytes) };
  })()`;
}

function decodeDesignReference(result) {
  if (exact(result, ['error'])) {
    if (typeof result.error !== 'string' || !result.error
      || result.error.length > MAX_REFERENCE_NAME_CODE_UNITS * 2) {
      throw new Error('verify-build returned an invalid bounded Figma error.');
    }
    throw new Error(result.error);
  }
  if (!exact(result, ['name', 'scale', 'base64'])
    || typeof result.name !== 'string' || result.name.length > MAX_REFERENCE_NAME_CODE_UNITS
    || !Number.isFinite(result.scale) || result.scale <= 0 || result.scale > 1
    || typeof result.base64 !== 'string' || !result.base64.length
    || result.base64.length > MAX_REFERENCE_BASE64_CODE_UNITS
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)) {
    throw new Error('verify-build returned an invalid bounded Figma reference.');
  }
  let png;
  try { png = PNG.sync.read(Buffer.from(result.base64, 'base64')); }
  catch { throw new Error('verify-build returned invalid Figma PNG data.'); }
  if (!Number.isSafeInteger(png.width) || !Number.isSafeInteger(png.height)
    || png.width < 1 || png.height < 1
    || png.width > FETCH_MAX_DIM || png.height > FETCH_MAX_DIM) {
    throw new Error('verify-build returned invalid bounded Figma PNG dimensions.');
  }
  return {
    image: { width: png.width, height: png.height, data: new Uint8Array(png.data) },
    scale: result.scale,
    nodeName: result.name,
  };
}

function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  return PNG.sync.write(png);
}

function jsonOutput(root, manifests, result, visual, fidelity) {
  return JSON.stringify({
    projectDir: root,
    manifests: manifests.map((manifest) => relative(root, manifest.path) || manifest.path),
    total: result.total,
    referenced: result.referenced.length,
    missing: result.missing.map(({ file, entries }) => ({ file, entries })),
    integrity: {
      ...result.integrity,
      mismatched: result.integrity.mismatched.map((item) => ({
        ...item,
        ...(item.path ? { path: relative(root, item.path) || item.path } : {}),
      })),
    },
    borderImage: result.borderImage.map((item) => ({
      file: relative(root, item.path), line: item.line,
    })),
    ...(visual ? { visual } : {}),
    ...(fidelity ? { fidelity } : {}),
  }, null, 2);
}

function textOutput(root, manifests, files, result, visual, fidelity, {
  maxDiff, visualFail, integrityFail,
}) {
  const lines = [];
  lines.push(`manifest(s): ${manifests.map((manifest) => relative(root, manifest.path) || manifest.path).join(', ')}`);
  lines.push(`${result.referenced.length}/${result.total} asset file(s) referenced in the build (${files.length} project files scanned)`);
  if (result.missing.length) {
    lines.push(`✗ ${result.missing.length} exported file(s) are NOT referenced anywhere:`);
    for (const missing of result.missing) lines.push(`  - ${describeMissing(missing)}`);
    lines.push('  Each of these is real artwork from the design. Prefer rootX/rootY in the export-root coordinate space (rotation-safe); x/y are immediate-parent offsets. Placement fields are in assets.json — never approximate the asset with CSS.');
  } else if (result.total) {
    lines.push('✓ every exported asset file is referenced.');
  }
  if (result.integrity.mismatched.length) {
    lines.push(`✗ ${result.integrity.mismatched.length} exported asset file(s) differ from their Manifest v2 digest:`);
    for (const item of result.integrity.mismatched) {
      lines.push(`  - ${item.file}${item.path ? ` (${relative(root, item.path)})` : ''}`);
      lines.push(`    expected ${item.expected}; actual ${item.actual || item.reason}`);
    }
  }
  if (result.integrity.missingFiles.length) {
    lines.push(`✗ ${result.integrity.missingFiles.length} Manifest v2 asset file(s) are missing from disk:`);
    for (const item of result.integrity.missingFiles) lines.push(`  - ${item.file}`);
  }
  if (result.integrity.checked.length) {
    lines.push(`✓ ${result.integrity.checked.length} Manifest v2 asset digest(s) verified.`);
  }
  if (result.integrity.unverified.length) {
    lines.push(`⚠ ${result.integrity.unverified.length} legacy asset file(s) have no Manifest v2 digest yet.`);
  }
  if (result.borderImage.length) {
    lines.push('⚠ border-image found (ignores border-radius — gradient strokes on rounded boxes lose their corners; use the wrapper/padding or mask pattern instead):');
    for (const item of result.borderImage) lines.push(`  - ${relative(root, item.path)}:${item.line}`);
  }
  if (fidelity) {
    lines.push('');
    lines.push(`source-fact ledger: ${fidelity.summary.matched}/${fidelity.summary.total} matched, `
      + `${fidelity.summary.approvedDeviations} approved deviation(s), ${fidelity.summary.missing} missing`);
    for (const fact of fidelity.facts.filter((item) => item.status !== 'matched')) {
      const marker = fact.status === 'approved-deviation' ? '⚠' : '✗';
      lines.push(`${marker} ${fact.id} [${fact.sourceNodeId}] → ${fact.property}: expected ${JSON.stringify(fact.expected)}`
        + `${Object.hasOwn(fact, 'actual') ? `, actual ${JSON.stringify(fact.actual)}` : ''}`);
    }
    if (fidelity.passed) lines.push('✓ every required source fact is accounted for.');
  }
  if (visual) {
    const reference = visual.reference.source === 'figma'
      ? `Figma node ${visual.reference.nodeId} "${visual.reference.nodeName}" (fetched at scale ${visual.reference.scale})`
      : visual.reference.path;
    lines.push('', `visual diff vs ${reference}:`);
    const marker = visual.diffPct > 10 ? '✗' : visual.diffPct > 2 ? '⚠' : '✓';
    lines.push(`${marker} ${visual.diffPct}% of the compared area differs`);
    if (visual.heightMismatch) {
      const height = visual.heightMismatch;
      lines.push(`⚠ the build is ${height.deltaPct}% ${height.direction} than the design (normalized heights ${height.buildH} vs ${height.designH}) — a missing or extra block; only the overlapping rows were compared.`);
    }
    if (visual.regions.length) {
      lines.push(`  worst regions (${visual.coordinateSpace}, worst first):`);
      for (const line of describeRegions({ regions: visual.regions })) lines.push(`  - ${line}`);
    }
    lines.push(`  diff image: ${visual.diffOut} — Read it; red = differing pixels on a dimmed design.`);
    lines.push('  A solid red band with correct content above it usually means a block was inserted/dropped there — everything below shifts. Cross-check the missing-asset findings above; region coordinates match the spec and assets.json placement fields.');
    if (visualFail) lines.push(`✗ --max-diff ${maxDiff}% exceeded.`);
  } else if (!result.missing.length && !integrityFail) {
    lines.push('⚠ ASSET-ONLY CHECK PASSED; VISUAL FIDELITY IS NOT VERIFIED. Do not declare the implementation done yet.');
    lines.push('  Screenshot your build at the design\'s width and re-run with --compare <build.png> (add --design <figma.png> to stay offline). This catches omitted gradients, wrong component variants/sizes, and shifted absolute overlays.');
  }
  return lines.join('\n');
}

export async function executeVerifyBuild(request, adapters = {}) {
  const io = adapters.workspaceIO;
  if (!io || typeof io.authorizePath !== 'function' || typeof io.read !== 'function'
    || typeof io.write !== 'function') {
    throw new TypeError('verify-build requires an authorized WorkspaceIO capability.');
  }
  const input = parseVerifyBuildRequest(verifyBuildArgvFromRequest(request));
  const root = input.projectDir;
  try {
    io.authorizePath(root, { access: 'read', role: 'verify-build-project', kind: 'directory' });
  } catch {
    throw new Error(`verify-build: ${root} is not a readable directory.`);
  }
  const { manifests: foundManifests, files } = scanProject(root, io);
  let manifests = foundManifests;
  if (input.assetsPath) {
    const manifestPath = basename(input.assetsPath) === 'assets.json'
      ? input.assetsPath : join(input.assetsPath, 'assets.json');
    try {
      manifests = [{
        path: manifestPath,
        data: io.readJson(manifestPath, { role: 'asset-manifest' }),
      }];
    } catch (error) {
      throw new Error(`verify-build: cannot read ${manifestPath}: ${error.message}`);
    }
  }
  if (!manifests.length) {
    throw new Error(`verify-build: no assets.json found under ${root}. Run \`export assets <nodeId> -o <projectDir>/src/assets\` first, or point at the manifest with --assets <path>.`);
  }

  const result = verifyBuild(
    manifests.map((manifest) => manifest.data),
    files,
    readManifestAssetFiles(manifests, io),
  );

  let fidelity = null;
  if (input.fidelityLedgerPath) {
    try {
      const ledger = io.readJson(input.fidelityLedgerPath, {
        role: 'verify-build-fidelity-ledger',
      });
      const captureBytes = io.read(input.browserCapturePath, {
        role: 'verify-build-browser-capture',
        maxBytes: BROWSER_DOM_CAPTURE_LIMITS.jsonBytes,
      });
      const capture = parseBoundedJson(captureBytes.toString('utf8'), {
        role: 'verify-build-browser-capture',
        limits: { ...io.limits, ...BROWSER_DOM_CAPTURE_LIMITS },
      });
      fidelity = verifyBrowserFidelityLedger(ledger, capture, {
        captureHash: createHash('sha256').update(captureBytes).digest('hex'),
      });
    } catch (error) {
      throw new Error(`verify-build: fidelity ledger failed: ${error.message}`);
    }
  }

  let visual = null;
  if (input.comparePath) {
    const build = loadImageOrThrow(input.comparePath, 'build screenshot (--compare)', io);
    let design;
    let reference;
    let nodeScale = 1;
    if (input.designPath) {
      design = loadImageOrThrow(input.designPath, 'design reference (--design)', io);
      reference = { source: 'file', path: input.designPath };
    } else {
      let nodeId = input.nodeId;
      if (!nodeId) {
        const roots = manifestRoots(manifests);
        if (roots.length === 1) nodeId = roots[0].id;
        else if (!roots.length) {
          throw new Error('verify-build --compare: assets.json names no export root — pass --node <nodeId> or --design <png>.');
        } else {
          const candidates = roots.map((rootEntry) => `  - ${rootEntry.id}  "${rootEntry.name || ''}"`).join('\n');
          throw new Error(`verify-build --compare: assets.json has ${roots.length} export roots — pass --node to pick the frame to compare against:\n${candidates}`);
        }
      }
      if (typeof adapters.evaluate !== 'function') {
        throw new TypeError('verify-build live comparison requires a Figma evaluate adapter.');
      }
      const fetched = decodeDesignReference(await adapters.evaluate(
        verifyBuildDesignReferenceCode(nodeId),
      ));
      design = fetched.image;
      nodeScale = fetched.scale;
      reference = {
        source: 'figma', nodeId, nodeName: fetched.nodeName, scale: fetched.scale,
      };
    }
    const diff = diffImages(design, build);
    const toNode = (value) => Math.round(value / nodeScale);
    const regions = diff.regions.map((region) => ({
      x0: toNode(region.x0), y0: toNode(region.y0),
      x1: toNode(region.x1), y1: toNode(region.y1), diffPct: region.diffPct,
    }));
    const diffOut = input.diffOutPath
      || join(dirname(input.comparePath), `${basename(input.comparePath, extname(input.comparePath))}-diff.png`);
    io.write(diffOut, encodePng(diff.diffImage), {
      role: 'verify-build-diff-out', createParents: true,
    });
    visual = {
      diffPct: diff.diffPct,
      compare: diff.compare,
      heightMismatch: diff.heightMismatch,
      regions,
      coordinateSpace: reference.source === 'figma' ? 'node px' : 'design-image px',
      reference,
      diffOut,
    };
  }

  const visualFail = Boolean(visual && input.maxDiff !== null
    && visual.diffPct > input.maxDiff);
  const integrityFail = Boolean(
    result.integrity.mismatched.length || result.integrity.missingFiles.length,
  );
  const fidelityFail = Boolean(fidelity && !fidelity.passed);
  const code = result.missing.length || integrityFail || visualFail || fidelityFail ? 1 : 0;
  const stdout = input.json
    ? jsonOutput(root, manifests, result, visual, fidelity)
    : textOutput(root, manifests, files, result, visual, fidelity, {
      maxDiff: input.maxDiff, visualFail, integrityFail,
    });
  return {
    stdout: boundedOutput(stdout),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    code,
    result: { verification: result, visual, fidelity },
  };
}

export async function executeVerifyBuildPlan(plan, adapters = {}) {
  if (verifyBuildPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by verify-build.`);
  }
  return executeVerifyBuild(parseVerifyBuildRequest(plan.argv), adapters);
}
