import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  legacyCommandRiskGateReason,
  planFigmaCommand,
} from '../src/capability-catalog.js';
import { resolveFigmaCommandAction } from '../src/figma-command-grammar.js';

const ENGINE_ENTRY = fileURLToPath(new URL('../engine/src/index.js', import.meta.url));
const state = mkdtempSync(join(tmpdir(), 'figma-bridge-risk-gates-'));
process.env.PLUGIN_KEY_FILE = join(state, 'plugin-key');
process.env.AUDIT_LOG_PATH = join(state, 'audit.log');

const cases = [
  {
    args: ['var', 'delete-all'],
    message: /delete-all is disabled/i,
  },
  {
    args: ['tokens', 'rebind', 'Theme', '--page', '--apply'],
    message: /(?:page-wide.*disabled|disabled.*page-wide)/i,
  },
  {
    args: ['node', 'set', '--batch', '[{"node":"1:2","name":"Private"}]'],
    message: /node set --batch is.*disabled/i,
  },
  {
    args: ['node', 'bind', '--batch', '[{"node":"1:2","property":"fill","variable":"brand"}]'],
    message: /node bind --batch is.*disabled/i,
  },
];

test('high-risk legacy write modes are denied by policy with static alternatives', () => {
  for (const { args, message } of cases) {
    assert.equal(planFigmaCommand(args, { adapter: 'mcp' }).allowed, false, args.join(' '));
    assert.match(legacyCommandRiskGateReason(args), message, args.join(' '));
  }
  assert.equal(resolveFigmaCommandAction(['var', 'delete-all']).accepted, false);
});

test('direct Commander gates fail before connection or Plugin dispatch', () => {
  for (const { args, message } of cases) {
    const result = spawnSync(process.execPath, [ENGINE_ENTRY, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PLUGIN_KEY_FILE: join(state, `${args[0]}-${args[1]}-key`),
        DAEMON_TOKEN_FILE: join(state, 'missing-daemon-token'),
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(output, message, args.join(' '));
    assert.doesNotMatch(output, /connect|daemon|plugin not/i,
      `${args.join(' ')} must stop before availability checks`);
  }
});

test('Source MCP returns the same actionable denial before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const { args, message } of cases) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, message, args.join(' '));
  }
});

test('safe adjacent utility remains available and literal payload cannot trigger a gate', () => {
  const allowed = [
    ['var', 'delete', 'space/md'],
    ['col', 'delete', 'Theme'],
    ['tokens', 'rebind', 'Theme', '--page'],
    ['tokens', 'rebind', 'Theme', '--node', '1:2', '--apply'],
    ['node', 'set', '1:2', '--name', 'Card'],
    ['node', 'bind', '1:2', 'fill', 'brand'],
  ];
  for (const args of allowed) {
    assert.equal(planFigmaCommand(args, { adapter: 'mcp' }).allowed, true, args.join(' '));
    assert.equal(legacyCommandRiskGateReason(args), null, args.join(' '));
  }
  assert.equal(planFigmaCommand(['tokens', 'rebind', 'Theme', '--page'], {
    adapter: 'mcp',
  }).effects.figma, 'read');
  assert.equal(planFigmaCommand(['tokens', 'rebind', 'Theme', '--node', '1:2', '--apply'], {
    adapter: 'mcp',
  }).effects.figma, 'write');
  assert.equal(legacyCommandRiskGateReason(
    ['tokens', 'rebind', 'Theme', '--', '--page', '--apply'],
  ), null);
  assert.equal(legacyCommandRiskGateReason(
    ['node', 'set', '1:2', '--', '--batch'],
  ), null);
});
