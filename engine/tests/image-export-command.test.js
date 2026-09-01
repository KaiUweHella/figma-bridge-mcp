import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeImageExportPlan,
  imageExportCode,
  imageExportPlanRoute,
  MAX_IMAGE_EXPORT_BASE64_CODE_UNITS,
  MAX_IMAGE_EXPORT_BYTES,
} from '../src/application/image-export-command.js';
import { MAX_PLUGIN_MESSAGE_BYTES } from '../src/lib/protocol-contract.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

function jpeg(width, height) {
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x00, 0x00, 0x00,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

const JPG = jpeg(40, 14);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

function capture(bytes, overrides = {}) {
  return {
    name: 'Card',
    id: '1:2',
    nodeWidth: 20,
    nodeHeight: 7,
    projectedWidth: 40,
    projectedHeight: 14,
    base64: bytes.toString('base64'),
    ...overrides,
  };
}

test('JPG, SVG and PDF use one Plan-bound Image Export Application for CLI and MCP', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'image-export-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const formats = [
    ['jpg', JPG],
    ['svg', SVG],
    ['pdf', PDF],
  ];
  for (const adapter of ['cli', 'mcp']) {
    for (const [format, bytes] of formats) {
      const output = `${adapter}-card.${format}`;
      const plan = planFigmaCommand([
        'export', 'node', '1:2', '--format', format, '--output', output,
      ], { adapter, workspaceDir: root, workspaceIO: io });
      assert.equal(plan.allowed, true);
      assert.equal(imageExportPlanRoute(plan), 'command-application');
      assert.deepEqual(plan.outputs, [{
        role: 'export-image-output', path: join(root, output),
      }]);
      let code = '';
      const result = await executeImageExportPlan(plan, {
        workspaceIO: io,
        evaluate: async (value) => {
          code = value;
          return capture(bytes);
        },
      });
      assert.doesNotThrow(() => new Function(`return ${code};`));
      assert.match(code, /getNodeByIdAsync\("1:2"\)/);
      assert.match(code, new RegExp(`format: "${format.toUpperCase()}"`));
      assert.deepEqual(readFileSync(join(root, output)), bytes);
      assert.equal(result.stdout, `✓ Exported Card (20x7) to ${join(root, output)}`);
      assert.equal(result.result.format, format.toUpperCase());
      assert.equal(result.result.byteLength, bytes.length);
    }
  }
});

test('selection Image Export preserves projected compatibility dimensions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'image-export-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const plan = planFigmaCommand([
    'export', 'screenshot', '--format', 'jpg', '--scale', '2', '--output', 'selection.jpg',
  ], { adapter: 'mcp', workspaceDir: root, workspaceIO: io });
  let code = '';
  const result = await executeImageExportPlan(plan, {
    workspaceIO: io,
    evaluate: async (value) => {
      code = value;
      return capture(JPG);
    },
  });
  assert.match(code, /figma\.currentPage\.selection/);
  assert.equal(result.stdout,
    `✓ Screenshot: Card (40x14) → ${join(root, 'selection.jpg')}`);
  assert.equal(result.result.pixelWidth, 40);
  assert.equal(result.result.pixelHeight, 14);
});

test('format bytes and Plugin evidence are validated before Workspace publication', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'image-export-rejection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const plan = planFigmaCommand([
    'export', 'node', '1:2', '--format', 'jpg', '--output', 'card.jpg',
  ], { adapter: 'mcp', workspaceDir: root, workspaceIO: io });
  const output = join(root, 'card.jpg');

  await assert.rejects(() => executeImageExportPlan(plan, {
    workspaceIO: io,
    evaluate: async () => capture(SVG),
  }), /JPEG signature/);
  assert.equal(existsSync(output), false);

  await assert.rejects(() => executeImageExportPlan(plan, {
    workspaceIO: io,
    evaluate: async () => ({ ...capture(JPG), privateField: 'must-not-pass' }),
  }), /invalid bounded node evidence/);
  assert.equal(existsSync(output), false);

  await assert.rejects(() => executeImageExportPlan(plan, {
    workspaceIO: io,
    evaluate: async () => capture(JPG, { id: '9:9', projectedWidth: 41 }),
  }), /invalid bounded node evidence/);
  assert.equal(existsSync(output), false);

  await assert.rejects(() => executeImageExportPlan(plan, {
    workspaceIO: io,
    evaluate: async () => ({ ...capture(JPG), base64: 'not/base64' }),
  }), /invalid bounded Base64/);
  assert.equal(existsSync(output), false);
});

test('SVG and PDF require complete bounded containers before publication', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'image-export-containers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  for (const [format, bytes, message] of [
    ['svg', Buffer.from('<svg><path/></svg-tail>'), /complete SVG root/],
    ['pdf', Buffer.from('%PDF-1.7\ntruncated'), /PDF terminator/],
  ]) {
    const output = `invalid.${format}`;
    const plan = planFigmaCommand([
      'export', 'node', '1:2', '--format', format, '--output', output,
    ], { adapter: 'mcp', workspaceDir: root, workspaceIO: io });
    await assert.rejects(() => executeImageExportPlan(plan, {
      workspaceIO: io,
      evaluate: async () => capture(bytes),
    }), message);
    assert.equal(existsSync(join(root, output)), false);
  }
});

test('Image Export refuses PNG and forged plans at the Application seam', async () => {
  const pngPlan = planFigmaCommand(['export', 'node', '1:2']);
  assert.equal(imageExportPlanRoute(pngPlan), 'not-image-export');
  await assert.rejects(() => executeImageExportPlan(pngPlan), /not owned/);
  assert.throws(() => imageExportPlanRoute({ ...pngPlan }), /requires a Command Plan/);
  assert.throws(() => imageExportCode({
    action: 'node', nodeId: '1:2', format: 'PNG', scale: 2,
  }), /PNG belongs to the Screenshot/);
});

test('Image Export leaves bounded envelope room inside the Plugin transport', () => {
  assert.ok(MAX_IMAGE_EXPORT_BASE64_CODE_UNITS < MAX_PLUGIN_MESSAGE_BYTES);
  assert.equal(MAX_IMAGE_EXPORT_BYTES,
    Math.floor(MAX_IMAGE_EXPORT_BASE64_CODE_UNITS / 4) * 3);
  const code = imageExportCode({
    action: 'node', nodeId: '1:2', format: 'JPG', scale: 2,
  });
  assert.match(code, new RegExp(`bytes\\.length > ${MAX_IMAGE_EXPORT_BYTES}`));
  assert.match(code, new RegExp(`base64\\.length > ${MAX_IMAGE_EXPORT_BASE64_CODE_UNITS}`));
});
