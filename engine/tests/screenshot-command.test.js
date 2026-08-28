import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeScreenshot,
  executeScreenshotPlan,
  screenshotCode,
  screenshotPlanRoute,
  screenshotPlanningArgvFromRequest,
} from '../src/application/screenshot-command.js';
import {
  acceptsScreenshotArgv,
  parseScreenshotRequest,
  screenshotArgvFromRequest,
} from '../src/application/screenshot-request.js';
import {
  acceptsLegacyRasterExportArgv,
  legacyRasterExportArgvFromRequest,
  legacyRasterExportPlanningArgvFromRequest,
  parseLegacyRasterExportRequest,
} from '../src/application/legacy-raster-export-request.js';
import {
  inspectVerificationPng,
  MAX_VERIFICATION_PNG_DIMENSION,
} from '../src/application/verification-artifact.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';
import { assertPosixMode } from '../../test-support/posix-permissions.js';

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const PNG = pngHeader(20, 7);

test('screenshot Command Application captures and persists through adapters', async () => {
  let saved = null;
  let code = '';
  const result = await executeScreenshot({ nodeId: '1-2', scale: 1, savePath: '/tmp/card.png' }, {
    evaluate: async (value) => {
      code = value;
      return {
        name: 'Card', id: '1:2', nodeWidth: 320, nodeHeight: 180,
        appliedScale: 1, base64: PNG.toString('base64'),
      };
    },
    save: async (path, bytes) => { saved = { path, bytes }; },
  });
  assert.match(code, /getNodeByIdAsync\("1:2"\)/);
  assert.equal(saved.path, '/tmp/card.png');
  assert.deepEqual(saved.bytes, PNG);
  assert.deepEqual(JSON.parse(result.stdout), {
    name: 'Card', id: '1:2', width: 20, height: 7,
    pixelWidth: 20, pixelHeight: 7,
    nodeWidth: 320, nodeHeight: 180,
    requestedScale: 1, appliedScale: 1, scale: 1,
    saved: '/tmp/card.png',
  });
});

test('default persistence and base64 are explicit Interface choices', async () => {
  const capture = {
    name: 'Hero', id: '9:8', nodeWidth: 200, nodeHeight: 100,
    appliedScale: 0.5, base64: PNG.toString('base64'),
  };
  let path = '';
  const saved = await executeScreenshot({ nodeId: '9:8', saveDefault: true }, {
    evaluate: async () => capture,
    save: async (value) => { path = value; },
    defaultSavePath: (value) => `/tmp/${value.id.replace(':', '-')}.png`,
  });
  assert.equal(path, '/tmp/9-8.png');
  assert.equal(JSON.parse(saved.stdout).base64, undefined);
  const inline = await executeScreenshot({ nodeId: '9:8', includeBase64: true }, { evaluate: async () => capture });
  assert.equal(JSON.parse(inline.stdout).base64, capture.base64);
});

test('verification PNG inspection rejects malformed and oversized raster evidence', () => {
  assert.deepEqual(inspectVerificationPng(PNG), { width: 20, height: 7 });
  assert.throws(() => inspectVerificationPng(Buffer.alloc(24)), /invalid PNG signature/);
  assert.throws(
    () => inspectVerificationPng(pngHeader(MAX_VERIFICATION_PNG_DIMENSION + 1, 1)),
    /dimensions exceed/,
  );
  assert.throws(() => inspectVerificationPng(pngHeader(10_000, 10_000)), /dimensions exceed/);
});

test('screenshot reports matching geometry and raster facts without conflating them', async () => {
  const exact = pngHeader(160, 90);
  const outcome = await executeScreenshot({ nodeId: '1:2', scale: 0.5, includeBase64: true }, {
    evaluate: async () => ({
      name: 'Exact', id: '1:2', nodeWidth: 320, nodeHeight: 180,
      appliedScale: 0.5, base64: exact.toString('base64'),
    }),
  });
  assert.deepEqual({
    pixelWidth: outcome.result.pixelWidth,
    pixelHeight: outcome.result.pixelHeight,
    nodeWidth: outcome.result.nodeWidth,
    nodeHeight: outcome.result.nodeHeight,
    requestedScale: outcome.result.requestedScale,
    appliedScale: outcome.result.appliedScale,
  }, {
    pixelWidth: 160, pixelHeight: 90, nodeWidth: 320, nodeHeight: 180,
    requestedScale: 0.5, appliedScale: 0.5,
  });
  let saved = false;
  await assert.rejects(() => executeScreenshot({ nodeId: '1:2', savePath: '/tmp/rejected.png' }, {
    evaluate: async () => ({
      name: 'Invalid', id: '1:2', nodeWidth: 20, nodeHeight: 20,
      appliedScale: 0.5, base64: Buffer.alloc(24).toString('base64'),
    }),
    save: async () => { saved = true; },
  }), /invalid bounded PNG data/);
  assert.equal(saved, false, 'malformed PNG evidence is rejected before persistence');
});

test('screenshot rejects a degenerate non-empty export with exact geometry and recovery guidance', async () => {
  let saved = false;
  await assert.rejects(() => executeScreenshot({
    nodeId: '1:2', scale: 0.5, savePath: '/tmp/degenerate.png',
  }, {
    evaluate: async () => ({
      name: 'Variant', id: '1:2', nodeWidth: 1512, nodeHeight: 92,
      appliedScale: 0.5, base64: pngHeader(1, 1).toString('base64'),
    }),
    save: async () => { saved = true; },
  }), (error) => {
    assert.match(error.message, /degenerate 1×1 PNG/i);
    assert.match(error.message, /node geometry 1512×92/);
    assert.match(error.message, /scaled geometry 756×46/);
    assert.match(error.message, /component","list/);
    assert.match(error.message, /parent Component Set/);
    assert.match(error.message, /not accepted or saved/i);
    return true;
  });
  assert.equal(saved, false);

  const legitimate = await executeScreenshot({ nodeId: '1:3', scale: 1 }, {
    evaluate: async () => ({
      name: 'Pixel', id: '1:3', nodeWidth: 1, nodeHeight: 1,
      appliedScale: 1, base64: pngHeader(1, 1).toString('base64'),
    }),
  });
  assert.equal(legitimate.result.pixelWidth, 1);
  assert.equal(legitimate.result.pixelHeight, 1);
});

test('screenshot validates deterministically and generated plugin code parses', async () => {
  await assert.rejects(() => executeScreenshot({ nodeId: '1:2', scale: 0 }, { evaluate: async () => ({}) }), /greater than 0/);
  await assert.rejects(() => executeScreenshot({ nodeId: '1:2' }, { evaluate: async () => ({ error: 'Node not found' }) }), /Node not found/);
  assert.doesNotThrow(() => new Function(`return ${screenshotCode({ nodeId: '1:2', scale: 0.5, maxDimension: 2000, measure: false })};`));
});

test('screenshot request closes selection, URL targeting, persistence and option order', () => {
  const url = 'https://www.figma.com/design/FILEA/Screen?node-id=12-34';
  assert.deepEqual(parseScreenshotRequest([
    'verify', '--measure', '--max=1600', url, '--scale', '1', '--save=shots/card.png',
  ]), {
    nodeId: '12:34', scale: 1, maxDimension: 1600, measure: true,
    includeBase64: false, persistence: 'workspace', savePath: 'shots/card.png',
  });
  assert.deepEqual(screenshotArgvFromRequest({ nodeId: '1-2' }), ['verify', '1:2']);
  assert.deepEqual(screenshotArgvFromRequest({ includeBase64: true }), ['verify', '--base64']);
  assert.equal(acceptsScreenshotArgv(['verify']), true, 'selection remains supported');
  for (const argv of [
    ['verify', 'bad-node'],
    ['verify', '1:2', '2:3'],
    ['verify', '1:2', '--future'],
    ['verify', '1:2', '--scale', '0'],
    ['verify', '1:2', '--save', 'shot.png', '--base64'],
  ]) assert.equal(acceptsScreenshotArgv(argv), false, argv.join(' '));
});

test('legacy raster export names retain closed PNG and non-PNG compatibility requests', () => {
  assert.deepEqual(parseLegacyRasterExportRequest([
    'export', 'node', '1-2', '--format=png', '-s2', '--output', 'card.png',
  ]), {
    action: 'node', nodeId: '1:2', scale: 2, format: 'PNG', outputPath: 'card.png',
  });
  assert.deepEqual(parseLegacyRasterExportRequest(['export', 'screenshot', '-f', 'svg']), {
    action: 'screenshot', nodeId: '', scale: 2, format: 'SVG', outputPath: 'screenshot.svg',
  });
  assert.deepEqual(legacyRasterExportArgvFromRequest({
    action: 'node', nodeId: '1:2', outputPath: 'card.png', scale: 2, format: 'PNG',
  }), ['export', 'node', '1:2', '-o', 'card.png']);
  assert.equal(legacyRasterExportPlanningArgvFromRequest({
    action: 'node',
    nodeId: 'https://www.figma.com/design/FILEA/Screen?node-id=12-34',
    format: 'PNG',
  })[2], 'https://www.figma.com/design/FILEA/Screen?node-id=12-34');
  for (const argv of [
    ['export', 'node'],
    ['export', 'node', '1:2', '2:3'],
    ['export', 'screenshot', '1:2'],
    ['export', 'node', '1:2', '--format', 'webp'],
    ['export', 'node', '1:2', '--scale', '0'],
    ['export', 'node', 'arbitrary-name'],
  ]) assert.equal(acceptsLegacyRasterExportArgv(argv), false, argv.join(' '));
});

test('PNG compatibility aliases use the Screenshot Plan while other formats stay explicit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-compatibility-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const nodePlan = planFigmaCommand(['export', 'node', '1:2'], {
    adapter: 'cli', workspaceDir: root, workspaceIO: io,
  });
  assert.equal(nodePlan.id, 'export.node');
  assert.equal(nodePlan.allowed, true);
  assert.equal(screenshotPlanRoute(nodePlan), 'command-application');
  assert.deepEqual(nodePlan.outputs, [{
    role: 'verification-image-output', path: join(root, 'node-export.png'),
    scope: 'workspace', cleanup: 'caller-owned',
  }]);
  const capture = {
    name: 'Card', id: '1:2', nodeWidth: 10, nodeHeight: 3.5,
    appliedScale: 2, base64: PNG.toString('base64'),
  };
  const result = await executeScreenshotPlan(nodePlan, { workspaceIO: io, evaluate: async () => capture });
  assert.equal(result.stdout, `✓ Exported Card (20x7) to ${join(root, 'node-export.png')}`);
  assert.deepEqual(readFileSync(join(root, 'node-export.png')), PNG);

  const selectionPlan = planFigmaCommand(['export', 'screenshot', '-o', 'selection.png'], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io,
  });
  assert.equal(screenshotPlanRoute(selectionPlan), 'command-application');
  const selectionResult = await executeScreenshotPlan(selectionPlan, {
    workspaceIO: io,
    evaluate: async () => ({ ...capture, name: 'Selection' }),
  });
  assert.equal(selectionResult.stdout,
    `✓ Screenshot: Selection (20x7) → ${join(root, 'selection.png')}`);

  const svgPlan = planFigmaCommand(['export', 'node', '1:2', '--format', 'svg'], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io,
  });
  assert.equal(screenshotPlanRoute(svgPlan), 'not-screenshot');
  assert.deepEqual(svgPlan.argv, [
    'export', 'node', '1:2', '-o', join(root, 'node-export.svg'), '-f', 'svg',
  ]);
  assert.deepEqual(svgPlan.outputs, [{
    role: 'export-image-output', path: join(root, 'node-export.svg'),
  }]);
});

test('default screenshot persistence is an exact private Plan artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const plan = planFigmaCommand(screenshotPlanningArgvFromRequest({ nodeId: '9:8' }), {
    adapter: 'cli', workspaceDir: root, workspaceIO: io,
    temporaryArtifactRoot: root,
    verificationArtifactNonce: 'screenshot-plan-artifact-0001',
  });
  assert.equal(screenshotPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.effects, {
    figma: 'read', workspace: 'none', network: 'none', shared: 'write',
  });
  assert.equal(plan.outputs.length, 1);
  assert.equal(plan.outputs[0].scope, 'private-temporary');
  const capture = {
    name: 'Hero', id: '9:8', nodeWidth: 42, nodeHeight: 17,
    appliedScale: 0.5, base64: PNG.toString('base64'),
  };
  const result = await executeScreenshotPlan(plan, { workspaceIO: io, evaluate: async () => capture });
  const saved = JSON.parse(result.stdout).saved;
  assert.equal(saved, plan.outputs[0].path);
  assert.deepEqual(readFileSync(saved), PNG);
  assertPosixMode(dirname(saved), 0o700);
  assertPosixMode(saved, 0o600);
  await assert.rejects(() => executeScreenshotPlan(plan, { workspaceIO: io, evaluate: async () => capture }),
    /private temporary directory already exists/);
  assert.deepEqual(readFileSync(saved), PNG, 'a collision never deletes or replaces the prior artifact');
  await assert.rejects(() => executeScreenshotPlan({ ...plan }, { evaluate: async () => capture }),
    /requires a Command Plan created by the Capability Catalog/);
});

test('private verification artifacts reject a pre-positioned directory symlink', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'screenshot-symlink-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const plan = planFigmaCommand(screenshotPlanningArgvFromRequest({ nodeId: '9:8' }), {
    adapter: 'cli', workspaceDir: root, workspaceIO: io,
    temporaryArtifactRoot: root,
    verificationArtifactNonce: 'screenshot-symlink-artifact-0001',
  });
  symlinkSync(outside, dirname(plan.outputs[0].path), 'dir');
  const capture = {
    name: 'Hero', id: '9:8', nodeWidth: 100, nodeHeight: 50, appliedScale: 0.5,
    base64: PNG.toString('base64'),
  };
  await assert.rejects(
    () => executeScreenshotPlan(plan, { workspaceIO: io, evaluate: async () => capture }),
    /private temporary directory already exists/,
  );
  assert.equal(existsSync(join(outside, 'capture.png')), false);
});

test('workspace and inline screenshot plans declare only their real effects', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const options = {
    workspaceDir: root,
    workspaceIO: io,
    verificationArtifactNonce: 'screenshot-plan-artifact-0002',
  };
  const workspace = planFigmaCommand(['verify', '1:2', '--save', 'shot.png'], options);
  assert.equal(workspace.argv.at(-1), join(root, 'shot.png'));
  assert.deepEqual(workspace.effects, {
    figma: 'read', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(workspace.outputs, [{
    role: 'verification-image-output', path: join(root, 'shot.png'), scope: 'workspace', cleanup: 'caller-owned',
  }]);
  const capture = {
    name: 'Card', id: '1:2', nodeWidth: 20, nodeHeight: 20,
    appliedScale: 0.5, base64: PNG.toString('base64'),
  };
  await executeScreenshotPlan(workspace, { workspaceIO: io, evaluate: async () => capture });
  assert.deepEqual(readFileSync(join(root, 'shot.png')), PNG);
  const inline = planFigmaCommand(['verify', '1:2', '--base64'], options);
  assert.deepEqual(inline.effects, {
    figma: 'read', workspace: 'none', network: 'none', shared: 'none',
  });
  assert.deepEqual(inline.outputs, []);
});
