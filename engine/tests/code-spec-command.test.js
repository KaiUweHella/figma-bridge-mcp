import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeCodeSpec } from '../src/application/code-spec-command.js';
import { createDesignCaptureModule } from '../src/application/design-capture.js';
import { parseSpecModel } from '../src/lib/spec-format.js';

const WALK_RESULT = {
  id: '1:2',
  name: 'Screen',
  frames: [{ t: 'FRAME', n: 'Screen', id: '1:2', w: 320, h: 640, kids: [
    { t: 'TEXT', n: 'Exact copy', id: '1:3', text: 'Exact copy', style: { fontSize: 16 } },
  ] }],
  sets: [],
};

function evaluator({ selection = ['1:2'], section = null, walk = WALK_RESULT } = {}) {
  const calls = [];
  return {
    calls,
    async evaluate(code) {
      calls.push(code);
      if (code.includes('figma.currentPage.selection.map')) return JSON.stringify(selection);
      if (code.includes('const root = await figma.getNodeByIdAsync')) {
        return JSON.stringify(section || { id: '1:4', name: 'Hero', matches: 1 });
      }
      return JSON.stringify(walk);
    },
  };
}

test('code-spec command returns the lossless default as values without a process adapter', async () => {
  const adapter = evaluator();
  const result = await executeCodeSpec({ nodeId: '1-2', depth: 12 }, adapter);
  const model = JSON.parse(result.stdout);
  assert.equal(result.format, 'json-compact');
  assert.equal(result.nodeId, '1:2');
  assert.equal(result.stderr, '');
  assert.equal(model.name, 'Screen');
  assert.equal(model.frames[0].kids[0].n, 'Exact copy');
  assert.deepEqual(model.capture, {
    phase: 'all', requestedDepth: 12, actualDepth: 12,
    includeHidden: false, payloadComplete: true, depthLimited: false,
  });
  assert.equal(adapter.calls.length, 1);
});

test('code-spec command resolves selection and named section behind one Interface', async () => {
  const adapter = evaluator({ section: { id: '1:4', name: 'Hero', matches: 2 } });
  const result = await executeCodeSpec({ section: 'hero', phase: 'style' }, adapter);
  assert.equal(result.nodeId, '1:4');
  assert.match(result.stderr, /section "hero" → Hero \[1:4\]/);
  assert.match(result.stderr, /2 name matches/);
  assert.equal(adapter.calls.length, 3);
  assert.match(adapter.calls[2], /getNodeByIdAsync\("1:4"\)/);
});

test('code-spec command validates its full Interface before touching Figma', async () => {
  const adapter = evaluator();
  await assert.rejects(() => executeCodeSpec({ phase: 'invent' }, adapter), /Unknown phase/);
  await assert.rejects(() => executeCodeSpec({ format: 'toml' }, adapter), /Unknown format/);
  await assert.rejects(() => executeCodeSpec({ depth: 0 }, adapter), /between 1 and 30/);
  assert.equal(adapter.calls.length, 0);
});

test('code-spec command never disguises an empty selection or plugin error as a spec', async () => {
  const empty = evaluator({ selection: [] });
  await assert.rejects(() => executeCodeSpec({}, empty), /nothing selected/);

  const failed = evaluator({ walk: { error: 'node not found' } });
  await assert.rejects(() => executeCodeSpec({ nodeId: '9:9' }, failed), /node not found/);
});

test('explicit-node requests accept one reusable Design Capture behind the Interface', async () => {
  const adapter = evaluator();
  let captures = 0;
  const captureDesign = async () => {
    captures++;
    return {
      result: WALK_RESULT,
      completeness: {
        requestedDepth: 12, actualDepth: 12, payloadComplete: true, depthLimited: false,
      },
    };
  };
  const structure = await executeCodeSpec({ nodeId: '1:2', phase: 'structure', format: 'json' }, {
    ...adapter, captureDesign,
  });
  const style = await executeCodeSpec({ nodeId: '1:2', phase: 'style', format: 'yaml' }, {
    ...adapter, captureDesign,
  });
  assert.equal(captures, 2, 'the Adapter decides whether the shared Capture is a cache hit');
  assert.equal(adapter.calls.length, 0, 'projection never performs its own walker eval');
  assert.equal(JSON.parse(structure.stdout).capture.phase, 'structure');
  assert.match(style.stdout, /phase: style/);
});

test('cached projections equal fresh projections and execute only one walker', async () => {
  const module = createDesignCaptureModule();
  let walks = 0;
  let probes = 0;
  const evaluateWithMetadata = async (code) => {
    const probe = code.includes('(async () => null)()');
    if (probe) probes++;
    else walks++;
    return {
      value: probe ? null : JSON.stringify(WALK_RESULT),
      metadata: {
        connectionId: 'CONN', fileKey: 'FILE',
        documentRevisionBefore: 3, documentRevisionAfter: 3,
      },
    };
  };
  const captureDesign = (request) => module.capture({ ...request, fileKey: 'FILE' }, { evaluateWithMetadata });
  const fresh = evaluator();
  const requests = [
    { nodeId: '1:2', phase: 'structure', format: 'json' },
    { nodeId: '1:2', phase: 'style', format: 'yaml' },
    { nodeId: '1:2', phase: 'all', format: 'json-compact', dedup: false },
  ];

  for (const request of requests) {
    const cached = await executeCodeSpec(request, { evaluate: fresh.evaluate, captureDesign });
    const uncached = await executeCodeSpec(request, fresh);
    assert.deepEqual(
      parseSpecModel(cached.stdout, request.format),
      parseSpecModel(uncached.stdout, request.format),
      `${request.phase}/${request.format}`,
    );
  }
  assert.equal(walks, 1);
  assert.equal(probes, 2);
});
