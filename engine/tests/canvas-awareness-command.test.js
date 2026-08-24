import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  canvasAwarenessPlanRoute,
  executeCanvasAwareness,
  executeCanvasAwarenessPlan,
} from '../src/application/canvas-awareness-command.js';
import {
  acceptsCanvasAwarenessArgv,
  canvasAwarenessArgvFromRequest,
  parseCanvasAwarenessRequest,
} from '../src/application/canvas-awareness-request.js';

test('Canvas Awareness request closes and canonicalizes info and next', () => {
  assert.deepEqual(parseCanvasAwarenessRequest(['canvas', 'info']), { action: 'info' });
  assert.deepEqual(parseCanvasAwarenessRequest([
    'canvas', 'next', '--direction=below', '-g-25',
  ]), { action: 'next', gap: -25, direction: 'below' });
  assert.deepEqual(canvasAwarenessArgvFromRequest({ action: 'next' }), ['canvas', 'next']);
  assert.deepEqual(canvasAwarenessArgvFromRequest({
    action: 'next', gap: 24.5, direction: 'below',
  }), ['canvas', 'next', '--gap', '24.5', '--direction', 'below']);

  for (const argv of [
    ['canvas', 'info', '--json'],
    ['canvas', 'info', 'payload'],
    ['canvas', 'next', '--future', 'private-value'],
    ['canvas', 'next', '--gap', '12px'],
    ['canvas', 'next', '--gap', '1', '-g2'],
    ['canvas', 'next', '--direction', 'diagonal'],
    ['canvas', 'next', '--direction'],
  ]) assert.equal(acceptsCanvasAwarenessArgv(argv), false, argv.join(' '));
});

test('Canvas Awareness Application preserves aggregate info and placement output', async () => {
  const info = {
    elements: 4,
    bounds: { x: -10, y: 0, width: 1080, height: 232 },
    nextX: 1170,
    nextY: 0,
    frames: 2,
    components: 1,
  };
  let infoCode = '';
  const infoResult = await executeCanvasAwareness({ action: 'info' }, {
    evaluate: async (code) => { infoCode = code; return info; },
  });
  assert.match(infoCode, /currentPage\.loadAsync\(\)/);
  assert.match(infoCode, /figma\.currentPage\.children/);
  assert.equal(infoResult.stdout, JSON.stringify(info, null, 2));
  assert.deepEqual(infoResult.result, info);

  let nextCode = '';
  const nextResult = await executeCanvasAwareness({
    action: 'next', gap: 24.5, direction: 'below',
  }, {
    evaluate: async (code) => { nextCode = code; return { x: 0, y: 256.5 }; },
  });
  assert.match(nextCode, /currentPage\.loadAsync\(\)/);
  assert.match(nextCode, /const gap = 24\.5/);
  assert.doesNotMatch(nextCode, /right|below/,
    'direction selects a static implementation instead of crossing the Plugin seam');
  assert.equal(nextResult.stdout, '{"x":0,"y":256.5}');
});

test('Canvas Awareness rejects malformed Plugin results instead of projecting plausible data', async () => {
  await assert.rejects(
    () => executeCanvasAwareness({ action: 'info' }, {
      evaluate: async () => ({ elements: 2, bounds: { x: 0, y: 0, width: Infinity, height: 10 } }),
    }),
    /invalid Canvas Awareness result/,
  );
  await assert.rejects(
    () => executeCanvasAwareness({ action: 'next' }, {
      evaluate: async () => ({ x: '0', y: 100 }),
    }),
    /invalid Canvas Awareness result/,
  );
});

test('Canvas Awareness Plan route accepts only authentic safe-read Plans', async () => {
  for (const argv of [['canvas', 'info'], ['canvas', 'next', '--gap=125', '-dbelow']]) {
    const plan = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(plan.allowed, true);
    assert.equal(plan.execution.retry, 'safe-read');
    assert.equal(canvasAwarenessPlanRoute(plan), 'command-application');
  }

  const plan = planFigmaCommand(['canvas', 'next', '--gap=125', '-dbelow']);
  assert.deepEqual(plan.argv, ['canvas', 'next', '--gap', '125', '--direction', 'below']);
  assert.deepEqual((await executeCanvasAwarenessPlan(plan, {
    evaluate: async () => ({ x: 0, y: 225 }),
  })).result, { x: 0, y: 225 });
  await assert.rejects(
    () => executeCanvasAwarenessPlan({ ...plan }, { evaluate: async () => ({ x: 0, y: 0 }) }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(
    canvasAwarenessPlanRoute(planFigmaCommand(['canvas', 'pages'])),
    'not-canvas-awareness',
  );
});

test('Canvas Awareness resolves policy-identical CLI and MCP Plans', () => {
  const input = ['canvas', 'next', '-dbelow', '--gap=125.5'];
  const cli = planFigmaCommand(input, { adapter: 'cli', fileKey: 'FILEPLACEHOLDER' });
  const mcp = planFigmaCommand(input, { adapter: 'mcp', fileKey: 'FILEPLACEHOLDER' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
  const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
  assert.deepEqual(cliPolicy, mcpPolicy);
  assert.deepEqual(cli.argv, ['canvas', 'next', '--gap', '125.5', '--direction', 'below']);
});
