import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
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
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('screenshot Command Application captures and persists through adapters', async () => {
  let saved = null;
  let code = '';
  const result = await executeScreenshot({ nodeId: '1-2', scale: 1, savePath: '/tmp/card.png' }, {
    evaluate: async (value) => {
      code = value;
      return { name: 'Card', id: '1:2', width: 320, height: 180, scale: 1, base64: PNG.toString('base64') };
    },
    save: async (path, bytes) => { saved = { path, bytes }; },
  });
  assert.match(code, /getNodeByIdAsync\("1:2"\)/);
  assert.equal(saved.path, '/tmp/card.png');
  assert.deepEqual(saved.bytes, PNG);
  assert.deepEqual(JSON.parse(result.stdout), {
    name: 'Card', id: '1:2', width: 320, height: 180, scale: 1, saved: '/tmp/card.png',
  });
});

test('default persistence and base64 are explicit Interface choices', async () => {
  const capture = { name: 'Hero', id: '9:8', width: 100, height: 50, scale: 0.5, base64: PNG.toString('base64') };
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
  const capture = { name: 'Hero', id: '9:8', width: 100, height: 50, scale: 0.5, base64: PNG.toString('base64') };
  const result = await executeScreenshotPlan(plan, { workspaceIO: io, evaluate: async () => capture });
  const saved = JSON.parse(result.stdout).saved;
  assert.equal(saved, plan.outputs[0].path);
  assert.deepEqual(readFileSync(saved), PNG);
  assert.equal(statSync(dirname(saved)).mode & 0o777, 0o700);
  assert.equal(statSync(saved).mode & 0o777, 0o600);
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
    name: 'Hero', id: '9:8', width: 100, height: 50, scale: 0.5,
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
  const capture = { name: 'Card', id: '1:2', width: 10, height: 10, scale: 0.5, base64: PNG.toString('base64') };
  await executeScreenshotPlan(workspace, { workspaceIO: io, evaluate: async () => capture });
  assert.deepEqual(readFileSync(join(root, 'shot.png')), PNG);
  const inline = planFigmaCommand(['verify', '1:2', '--base64'], options);
  assert.deepEqual(inline.effects, {
    figma: 'read', workspace: 'none', network: 'none', shared: 'none',
  });
  assert.deepEqual(inline.outputs, []);
});
