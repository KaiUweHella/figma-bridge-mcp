import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeJsonExportPlan,
  MAX_NODE_JSON_DEPTH,
  MAX_NODE_JSON_ENTRIES,
  MAX_NODE_JSON_PLUGIN_BYTES,
  nodeJsonExportCode,
  nodeJsonExportPlanRoute,
} from '../src/application/node-json-export-command.js';
import {
  nodeJsonExportArgvFromRequest,
  nodeJsonExportPlanningArgvFromRequest,
  parseNodeJsonExportRequest,
} from '../src/application/node-json-export-request.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../src/lib/protocol-contract.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const URL = 'https://www.figma.com/design/FILEA/JSON-Lab?node-id=1-2';

function envelope(overrides = {}) {
  return {
    nodeId: '1:2',
    value: {
      id: '1:2',
      name: 'Card',
      type: 'FRAME',
      visible: true,
      children: [{ id: '2:1', name: 'Label', type: 'TEXT', characters: 'Hello' }],
    },
    ...overrides,
  };
}

test('Node JSON Export closes request grammar and preserves URL target identity only for planning', () => {
  assert.deepEqual(parseNodeJsonExportRequest([
    'export', 'node-json', '1-2', '--output=facts.json',
  ]), { nodeId: '1:2', warning: '', outputPath: 'facts.json' });
  assert.deepEqual(nodeJsonExportArgvFromRequest({
    nodeId: URL, outputPath: 'facts.json',
  }), ['export', 'node-json', '1:2', '-o', 'facts.json']);
  assert.deepEqual(nodeJsonExportPlanningArgvFromRequest({
    nodeId: URL, outputPath: 'facts.json',
  }), ['export', 'node-json', URL, '-o', 'facts.json']);
  assert.deepEqual(nodeJsonExportArgvFromRequest({
    nodeId: '1:2', outputPath: '-facts.json',
  }), ['export', 'node-json', '1:2', '--output=-facts.json']);

  for (const args of [
    ['export', 'node-json'],
    ['export', 'node-json', 'bad-node'],
    ['export', 'node-json', '1:2', '2:3'],
    ['export', 'node-json', '1:2', '--future'],
    ['export', 'node-json', '1:2', '-o'],
    ['export', 'node-json', '1:2', '-o', 'one.json', '--output', 'two.json'],
  ]) assert.throws(() => parseNodeJsonExportRequest(args));
  for (const request of [
    { nodeId: 12, outputPath: null },
    { nodeId: '1:2', outputPath: '' },
    { nodeId: '1:2', outputPath: 12 },
  ]) assert.throws(() => nodeJsonExportArgvFromRequest(request));
});

test('JSON_REST_V1 is exported from the live Plugin document with one bounded envelope', async () => {
  const value = envelope().value;
  let settings = null;
  const node = {
    id: '1:2',
    type: 'FRAME',
    exportAsync: async (input) => { settings = input; return value; },
  };
  const figma = { getNodeByIdAsync: async () => node };
  const result = await new Function(
    'figma', `return ${nodeJsonExportCode({ nodeId: node.id, outputPath: null })}`,
  )(figma);
  assert.deepEqual(settings, { format: 'JSON_REST_V1' });
  assert.deepEqual(result, { nodeId: '1:2', value });
});

test('CLI and MCP use one safe-read Plan-bound Node JSON Export Application', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'node-json-export-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });

  for (const adapter of ['cli', 'mcp']) {
    const output = `${adapter}-facts.json`;
    const plan = planFigmaCommand([
      'export', 'node-json', URL, '-o', output,
    ], { adapter, workspaceDir: root, workspaceIO: io });
    assert.equal(plan.allowed, true);
    assert.equal(plan.execution.retry, 'safe-read');
    assert.deepEqual(plan.effects, {
      figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
    });
    assert.deepEqual(plan.target, {
      kind: 'plugin-file', fileKey: 'FILEA', source: 'figma-url',
    });
    assert.deepEqual(plan.argv, [
      'export', 'node-json', '1:2', '-o', join(root, output),
    ]);
    assert.deepEqual(plan.outputs, [{
      role: 'node-json-output', path: join(root, output),
    }]);
    assert.equal(nodeJsonExportPlanRoute(plan), 'command-application');

    let code = '';
    const result = await executeNodeJsonExportPlan(plan, {
      workspaceIO: io,
      evaluate: async (value) => {
        code = value;
        return envelope();
      },
    });
    assert.doesNotThrow(() => new Function(`return ${code};`));
    assert.match(code, /getNodeByIdAsync\("1:2"\)/);
    assert.match(code, /format: 'JSON_REST_V1'/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, output), 'utf8')), envelope().value);
    assert.equal(result.stdout, `✓ Native node JSON written to ${join(root, output)}`);
    assert.deepEqual(result.result, {
      nodeId: '1:2',
      type: 'FRAME',
      byteLength: Buffer.byteLength(readFileSync(join(root, output), 'utf8')),
      saved: join(root, output),
    });
  }
});

test('inline and persisted Node JSON Export preserve the same validated JSON semantics', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'node-json-export-semantics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const value = envelope().value;
  value.name = 'Directional \u202e label\u2028next';

  const inline = planFigmaCommand(['export', 'node-json', '1:2'], {
    adapter: 'cli', workspaceDir: root, workspaceIO: io,
  });
  const inlineResult = await executeNodeJsonExportPlan(inline, {
    evaluate: async () => envelope({ value }),
  });
  assert.match(inlineResult.stdout, /\\u202e/);
  assert.match(inlineResult.stdout, /\\u2028/);
  assert.deepEqual(JSON.parse(inlineResult.stdout), value);

  const persisted = planFigmaCommand([
    'export', 'node-json', '1:2', '-o', 'facts.json',
  ], { adapter: 'mcp', workspaceDir: root, workspaceIO: io });
  await executeNodeJsonExportPlan(persisted, {
    workspaceIO: io,
    evaluate: async () => envelope({ value }),
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'facts.json'), 'utf8')), value);
});

test('malformed or unbounded Plugin facts fail before Workspace publication', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'node-json-export-rejection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const output = join(root, 'facts.json');
  const plan = planFigmaCommand([
    'export', 'node-json', '1:2', '-o', 'facts.json',
  ], { adapter: 'mcp', workspaceDir: root, workspaceIO: io });

  let getterRead = false;
  const accessorEnvelope = {};
  Object.defineProperty(accessorEnvelope, 'nodeId', {
    enumerable: true,
    get() { getterRead = true; return '1:2'; },
  });
  Object.defineProperty(accessorEnvelope, 'value', {
    enumerable: true,
    value: envelope().value,
  });

  const cyclic = envelope().value;
  cyclic.self = cyclic;
  const sparse = envelope().value;
  sparse.children = new Array(1);
  const deep = envelope().value;
  let cursor = deep;
  for (let index = 0; index <= MAX_NODE_JSON_DEPTH; index++) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const many = envelope().value;
  many.children = Array.from({ length: MAX_NODE_JSON_ENTRIES + 1 }, () => null);

  const rejected = [
    { ...envelope(), extra: true },
    envelope({ nodeId: '9:9' }),
    envelope({ value: { ...envelope().value, id: '9:9' } }),
    envelope({ value: { ...envelope().value, type: 'frame' } }),
    accessorEnvelope,
    envelope({ value: cyclic }),
    envelope({ value: sparse }),
    envelope({ value: deep }),
    envelope({ value: many }),
  ];
  for (const result of rejected) {
    await assert.rejects(() => executeNodeJsonExportPlan(plan, {
      workspaceIO: io,
      evaluate: async () => result,
    }), /invalid bounded node facts/);
    assert.equal(existsSync(output), false);
  }
  assert.equal(getterRead, false, 'host validation must not invoke result accessors');
});

test('Node JSON Export rejects unsafe error envelopes, forged plans and output ownership drift', async () => {
  const plan = planFigmaCommand(['export', 'node-json', '1:2']);
  await assert.rejects(() => executeNodeJsonExportPlan(plan, {
    evaluate: async () => ({ error: 'unsafe\u202eerror' }),
  }), /invalid bounded Figma error/);
  assert.throws(() => nodeJsonExportPlanRoute({ ...plan }), /requires a Command Plan/);
  await assert.rejects(() => executeNodeJsonExportPlan({ ...plan }, {
    evaluate: async () => envelope(),
  }), /requires a Command Plan/);

  const persisted = planFigmaCommand([
    'export', 'node-json', '1:2', '-o', 'facts.json',
  ], { workspaceDir: '/work' });
  const drifted = { ...persisted, outputs: [] };
  await assert.rejects(() => executeNodeJsonExportPlan(drifted, {
    evaluate: async () => envelope(),
  }), /requires a Command Plan/);
});

test('Node JSON Export leaves bounded room inside the generic Plugin result transport', () => {
  assert.ok(MAX_NODE_JSON_PLUGIN_BYTES < MAX_PROTOCOL_VALUE_BYTES);
  const code = nodeJsonExportCode({ nodeId: '1:2', outputPath: null });
  assert.match(code, /JSON\.stringify\(\{ nodeId: node\.id, value \}\)/);
  assert.match(code, new RegExp(`utf8Bytes\\(serialized, ${MAX_NODE_JSON_PLUGIN_BYTES}\\)`));
  assert.match(code, /exceeds the bounded Plugin result/);
});
