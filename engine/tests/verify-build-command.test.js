import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVerifyBuildPlan,
  verifyBuildDesignReferenceCode,
  verifyBuildPlanRoute,
} from '../src/application/verify-build-command.js';
import {
  parseVerifyBuildRequest,
  verifyBuildArgvFromRequest,
  verifyBuildFigmaUrlFileKeyFromArgv,
} from '../src/application/verify-build-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const TARGET_URL = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=12-34';

function pngBytes(color = [255, 255, 255], width = 8, height = 6) {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function fixture({ referenced = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-build-command-'));
  const assets = join(root, 'src', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'assets.json'), JSON.stringify({
    root: '1:1',
    rootName: 'Frame',
    roots: [{ id: '1:1', name: 'Frame' }],
    assets: [{ nodeId: '1:2', file: 'deco.svg', kind: 'vector' }],
  }));
  writeFileSync(join(root, 'src', 'App.tsx'), referenced
    ? "import deco from './assets/deco.svg';" : 'export const App = () => null;');
  return { root, io: createWorkspaceIO({ root }) };
}

test('verify-build request closes options, literal arity, paired facts, and target URLs', () => {
  const request = parseVerifyBuildRequest([
    'verify-build', '.', '--compare=build.png', '--node', TARGET_URL,
    '--max-diff', '5', '--json',
  ]);
  assert.equal(request.projectDir, '.');
  assert.equal(request.comparePath, 'build.png');
  assert.equal(request.nodeId, '12:34');
  assert.equal(request.maxDiff, 5);
  assert.equal(request.needsFigma, true);
  assert.equal(verifyBuildFigmaUrlFileKeyFromArgv([
    'verify-build', '.', '--compare', 'build.png', '--node', TARGET_URL,
  ]), 'TARGETPLACEHOLDERKEY');
  for (const argv of [
    ['verify-build'],
    ['verify-build', '.', 'extra'],
    ['verify-build', '.', '--future'],
    ['verify-build', '.', '--compare'],
    ['verify-build', '.', '--compare', 'a.png', '--compare', 'b.png'],
    ['verify-build', '.', '--max-diff', '101'],
    ['verify-build', '.', '--fidelity-ledger', 'facts.json'],
  ]) assert.throws(() => parseVerifyBuildRequest(argv), /Invalid verify-build command/);
});

test('verify-build canonical argv distinguishes live comparison from ignored node hints', () => {
  assert.deepEqual(verifyBuildArgvFromRequest({
    projectDir: '/work', comparePath: '/work/build.png', nodeId: TARGET_URL,
  }), ['verify-build', '/work', '--compare', '/work/build.png', '--node', '12:34']);
  assert.equal(planFigmaCommand(['verify-build', '.', '--node', '12:34']).target.kind, 'none');
  assert.equal(planFigmaCommand(['verify-build', '.', '--compare', 'build.png']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand([
    'verify-build', '.', '--compare', 'build.png', '--design', 'design.png', '--node', TARGET_URL,
  ]).target.kind, 'none');
});

test('verify-build Plans expose the exact default diff output and match across CLI and MCP', () => {
  const { root } = fixture();
  const args = ['verify-build', '.', '--compare', 'build.png', '--design', 'design.png', '--json'];
  const cli = planFigmaCommand(args, { adapter: 'cli', workspaceDir: root });
  const mcp = planFigmaCommand(args, { adapter: 'mcp', workspaceDir: root });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.outputs, [{
    role: 'verify-build-diff-out', path: join(root, 'build-diff.png'),
  }]);
  assert.equal(cli.effects.workspace, 'write');
  assert.equal(verifyBuildPlanRoute(cli), 'command-application');
});

test('offline verify-build preserves JSON findings and accepted domain exit codes', async () => {
  const clean = fixture();
  const cleanPlan = planFigmaCommand(['verify-build', clean.root, '--json'], {
    adapter: 'cli', workspaceDir: clean.root, workspaceIO: clean.io,
  });
  const cleanResult = await executeVerifyBuildPlan(cleanPlan, { workspaceIO: clean.io });
  assert.equal(cleanResult.code, 0);
  assert.equal(JSON.parse(cleanResult.stdout).referenced, 1);
  assert.equal(cleanResult.stderr, '');

  const missing = fixture({ referenced: false });
  const missingPlan = planFigmaCommand(['verify-build', missing.root, '--json'], {
    adapter: 'mcp', workspaceDir: missing.root, workspaceIO: missing.io,
  });
  const missingResult = await executeVerifyBuildPlan(missingPlan, { workspaceIO: missing.io });
  assert.equal(missingResult.code, 1);
  assert.equal(JSON.parse(missingResult.stdout).missing[0].file, 'deco.svg');
});

test('offline visual comparison writes only its Plan-owned diff and never reads Figma', async () => {
  const { root, io } = fixture();
  const build = join(root, 'build.png');
  const design = join(root, 'design.png');
  writeFileSync(build, pngBytes([255, 0, 0]));
  writeFileSync(design, pngBytes([255, 255, 255]));
  const plan = planFigmaCommand([
    'verify-build', root, '--compare', build, '--design', design,
    '--node', TARGET_URL, '--max-diff', '0', '--json',
  ], { adapter: 'mcp', workspaceDir: root, workspaceIO: io });
  let evaluations = 0;
  const result = await executeVerifyBuildPlan(plan, {
    workspaceIO: io,
    evaluate: async () => { evaluations++; throw new Error('must stay offline'); },
  });
  assert.equal(result.code, 1);
  assert.equal(evaluations, 0);
  assert.match(result.stderr, /using the --design file/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.visual.reference.source, 'file');
  assert.equal(output.visual.diffOut, join(root, 'build-diff.png'));
  assert.equal(existsSync(output.visual.diffOut), true);
});

test('live visual comparison uses one bounded Figma read and the manifest root default', async () => {
  const { root, io } = fixture();
  const build = join(root, 'build.png');
  const bytes = pngBytes();
  writeFileSync(build, bytes);
  const plan = planFigmaCommand(['verify-build', root, '--compare', build, '--json'], {
    adapter: 'cli', workspaceDir: root, workspaceIO: io,
  });
  let code = '';
  const result = await executeVerifyBuildPlan(plan, {
    workspaceIO: io,
    evaluate: async (value) => {
      code = value;
      return { name: 'Frame', scale: 1, base64: bytes.toString('base64') };
    },
  });
  assert.equal(result.code, 0);
  assert.match(code, /getNodeByIdAsync\("1:1"\)/);
  assert.doesNotMatch(code, /process|console/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.visual.reference.source, 'figma');
  assert.equal(output.visual.reference.nodeId, '1:1');
  assert.equal(readFileSync(output.visual.diffOut).equals(readFileSync(join(root, 'build-diff.png'))), true);
});

test('malformed or forged Figma results cannot become visual facts', async () => {
  const { root, io } = fixture();
  const build = join(root, 'build.png');
  writeFileSync(build, pngBytes());
  const plan = planFigmaCommand(['verify-build', root, '--compare', build, '--json'], {
    workspaceDir: root, workspaceIO: io,
  });
  await assert.rejects(() => executeVerifyBuildPlan(plan, {
    workspaceIO: io,
    evaluate: async () => ({ name: 'Frame', scale: 1, base64: 'not-png' }),
  }), /invalid bounded Figma reference/);
  assert.equal(existsSync(join(root, 'build-diff.png')), false);
  await assert.rejects(() => executeVerifyBuildPlan({ ...plan }, { workspaceIO: io }),
    /Command Plan created by the Capability Catalog/);
});

test('verify-build generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function('figma', `return ${verifyBuildDesignReferenceCode('1:2')};`));
});
