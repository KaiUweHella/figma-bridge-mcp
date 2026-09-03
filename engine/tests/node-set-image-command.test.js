import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executePreparedNodeSetImage,
  nodeSetImageCode,
  nodeSetImagePlanRoute,
  nodeSetImagePlanningArgvFromRequest,
  prepareNodeSetImagePlan,
} from '../src/application/node-set-image-command.js';
import { IMAGE_HARD_LIMIT } from '../src/lib/image-file.js';
import { evalTransportEnvelopeError } from '../src/lib/protocol-contract.js';
import { parseNodeSetImageRequest } from '../src/application/node-set-image-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'node-set-image-'));
  const file = join(root, 'pixel.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { file, io: createWorkspaceIO({ root }) };
}

function figmaFixture({ fillMode = 'normal', annotationMode = 'normal', readFailures = [] } = {}) {
  let reads = 0;
  let fillAssignments = 0;
  let annotationAssignments = 0;
  const beforeFills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  const beforeAnnotations = [{ label: 'Replace this image' }];
  const node = {
    id: '1:2', name: 'Hero', type: 'RECTANGLE', _fills: beforeFills, _annotations: beforeAnnotations,
    get fills() { return this._fills; },
    set fills(value) {
      fillAssignments++;
      if (fillMode === 'ignore-request' && fillAssignments === 1) return;
      if (fillMode === 'ignore-all') return;
      this._fills = value;
    },
    get annotations() { return this._annotations; },
    set annotations(value) {
      annotationAssignments++;
      if (annotationMode === 'throw') throw new Error('annotations are not writable');
      if (annotationMode === 'ignore') return;
      this._annotations = value;
    },
  };
  const figma = {
    async getNodeByIdAsync(id) {
      reads++;
      if (readFailures.includes(reads)) throw new Error('read failed');
      return id === node.id ? node : null;
    },
    base64Decode(value) { return Uint8Array.from(Buffer.from(value, 'base64')); },
    createImage(bytes) {
      assert.ok(bytes.length > 0);
      return { hash: 'image-hash-1' };
    },
  };
  return {
    figma, node, beforeFills, beforeAnnotations,
    get fillAssignments() { return fillAssignments; },
    get annotationAssignments() { return annotationAssignments; },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Set Image closes URL identity, path, scale, and legacy invalid-scale fallback', () => {
  const url = 'https://www.figma.com/design/FILEA/Image-Lab?node-id=1-2';
  assert.deepEqual(parseNodeSetImageRequest([
    'node', 'set-image', '--scale', 'crop', url, '/work/pixel.png',
  ]), { nodeId: '1:2', file: '/work/pixel.png', scale: 'CROP' });
  assert.deepEqual(nodeSetImagePlanningArgvFromRequest({
    nodeId: url, file: '/work/pixel.png', scale: 'future-mode',
  }), ['node', 'set-image', url, '--scale', 'FILL', '--', '/work/pixel.png']);
  for (const args of [
    ['node', 'set-image'],
    ['node', 'set-image', 'bad', '/work/pixel.png'],
    ['node', 'set-image', '1:2', '/work/pixel.png', 'extra'],
    ['node', 'set-image', '1:2', '/work/pixel.png', '--future'],
  ]) assert.throws(() => parseNodeSetImageRequest(args));
});

test('preparation reads bounded image bytes before Plugin dispatch and requires an authentic Plan', () => {
  const { file, io } = workspaceFixture();
  const plan = planFigmaCommand(['node', 'set-image', '1:2', file], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: io.roots[0], fileKey: 'FILEA',
  });
  assert.equal(nodeSetImagePlanRoute(plan), 'command-application');
  const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
  assert.equal(prepared.request.file, file);
  assert.equal(prepared.sourceBytes, 4);
  assert.throws(() => nodeSetImagePlanRoute({ ...plan }), /requires a Command Plan/);
});

test('one prepared execution verifies exact image fill and clears placeholder annotations', async () => {
  const { file, io } = workspaceFixture();
  const plan = planFigmaCommand(['node', 'set-image', '1:2', file, '--scale=fit'], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: io.roots[0], fileKey: 'FILEA',
  });
  const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
  const live = figmaFixture();
  let dispatches = 0;
  const result = await executePreparedNodeSetImage(prepared, {
    evaluate: async (code) => { dispatches++; return evaluate(live.figma)(code); },
  });
  assert.equal(dispatches, 1);
  assert.deepEqual(live.node.fills, [{ type: 'IMAGE', imageHash: 'image-hash-1', scaleMode: 'FIT' }]);
  assert.deepEqual(live.node.annotations, []);
  assert.equal(result.result.annotations, 'cleared');
});

test('annotation clearing stays best-effort without weakening exact fill verification', async () => {
  const { file, io } = workspaceFixture();
  const plan = planFigmaCommand(['node', 'set-image', '1:2', file], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: io.roots[0], fileKey: 'FILEA',
  });
  const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
  const live = figmaFixture({ annotationMode: 'throw' });
  const result = await executePreparedNodeSetImage(prepared, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.annotations, 'retained');
  assert.equal(live.node.fills[0].imageHash, 'image-hash-1');
  assert.deepEqual(live.node.annotations, live.beforeAnnotations);
});

test('post-create failure restores Node fields but reports the non-deletable image resource', async () => {
  const { file, io } = workspaceFixture();
  const plan = planFigmaCommand(['node', 'set-image', '1:2', file], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: io.roots[0], fileKey: 'FILEA',
  });
  const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
  const live = figmaFixture({ fillMode: 'ignore-request' });
  await assert.rejects(
    () => executePreparedNodeSetImage(prepared, { evaluate: evaluate(live.figma) }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
  assert.deepEqual(live.node.fills, live.beforeFills);
  assert.deepEqual(live.node.annotations, live.beforeAnnotations);
});

test('unavailable post-create verification remains non-retryable and retains known resource residue', async () => {
  const { file, io } = workspaceFixture();
  const plan = planFigmaCommand(['node', 'set-image', '1:2', file], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: io.roots[0], fileKey: 'FILEA',
  });
  const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
  const live = figmaFixture({ readFailures: [2, 3] });
  await assert.rejects(
    () => executePreparedNodeSetImage(prepared, { evaluate: evaluate(live.figma) }),
    (error) => error.mutationOutcome === 'verification-unavailable'
      && error.mutationReport.residueCount === 1,
  );
});

test('preflight refusals are known no-mutation and malformed Plugin results fail closed', async () => {
  const { file, io } = workspaceFixture();
  const plan = planFigmaCommand(['node', 'set-image', '1:2', file], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: io.roots[0], fileKey: 'FILEA',
  });
  const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
  await assert.rejects(() => executePreparedNodeSetImage({ ...prepared }, {
    evaluate: evaluate(figmaFixture().figma),
  }), /authentic prepared input/);
  const missing = figmaFixture();
  missing.node.id = '9:9';
  await assert.rejects(
    () => executePreparedNodeSetImage(prepared, { evaluate: evaluate(missing.figma) }),
    (error) => error.mutationOutcome === 'no-mutation',
  );
  for (const value of [null, {}, 'bad', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(
      () => executePreparedNodeSetImage(prepared, { evaluate: async () => value }),
      /invalid/i,
    );
  }
});

test('a file over the inbound ceiling is refused with guidance, and one at the ceiling fits the transport', () => {
  const root = mkdtempSync(join(tmpdir(), 'node-set-image-limit-'));
  const io = createWorkspaceIO({ root });
  const oversized = join(root, 'oversized.png');
  writeFileSync(oversized, Buffer.alloc(IMAGE_HARD_LIMIT + 1));
  const plan = planFigmaCommand(['node', 'set-image', '1:2', oversized], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: root, fileKey: 'FILEA',
  });
  assert.throws(
    () => prepareNodeSetImagePlan(plan, { workspaceIO: io }),
    (error) => /over the \d+ byte ceiling/.test(error.message)
      && /base64/.test(error.message)
      && !/8 MB/.test(error.message),
  );

  // The ceiling must be the transport's, not a number the transport refuses:
  // the generated eval for a file exactly at the limit has to fit the
  // protocol envelope, or the friendly refusal above is unreachable.
  const atLimit = join(root, 'at-limit.png');
  writeFileSync(atLimit, Buffer.alloc(IMAGE_HARD_LIMIT, 0xff));
  const fitting = planFigmaCommand(['node', 'set-image', '1:2', atLimit], {
    adapter: 'mcp', workspaceIO: io, workspaceDir: root, fileKey: 'FILEA',
  });
  const prepared = prepareNodeSetImagePlan(fitting, { workspaceIO: io });
  assert.equal(prepared.sourceBytes, IMAGE_HARD_LIMIT);
  assert.equal(evalTransportEnvelopeError(nodeSetImageCode(prepared)), null);
});
