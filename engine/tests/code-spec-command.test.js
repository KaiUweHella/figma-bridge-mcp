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

test('code-spec command defaults to the readable agent tree without a process adapter', async () => {
  const adapter = evaluator();
  const result = await executeCodeSpec({ nodeId: '1-2', depth: 12 }, adapter);
  assert.equal(result.format, 'tree');
  assert.equal(result.nodeId, '1:2');
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^# Code-Spec: Screen \(1:2\)/);
  assert.match(result.stdout, /Exact copy/);
  assert.match(result.stdout, /copy, never invent/);
  assert.ok(result.stdout.split('\n').length > 5, 'default must be scannable, not one minified line');
  assert.equal(adapter.calls.length, 1);
});

test('YAML remains an explicit lossless adapter', async () => {
  const adapter = evaluator();
  const result = await executeCodeSpec({ nodeId: '1:2', depth: 12, format: 'yaml' }, adapter);
  const model = parseSpecModel(result.stdout, 'yaml');
  assert.equal(result.format, 'yaml');
  assert.equal(model.name, 'Screen');
  assert.equal(model.frames[0].kids[0].n, 'Exact copy');
  assert.deepEqual(model.capture, {
    phase: 'all', requestedDepth: 12, actualDepth: 12,
    includeHidden: false, payloadComplete: true, depthLimited: false,
  });
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
  await assert.rejects(() => executeCodeSpec({ depth: -1 }, adapter), /between 0 and 30/);
  assert.equal(adapter.calls.length, 0);
});

test('depth 0 is an exact node-only style contract', async () => {
  const adapter = evaluator();
  const result = await executeCodeSpec({ nodeId: '1:2', phase: 'style', depth: 0 }, {
    ...adapter,
    captureDesign: async () => ({
      result: {
        id: '1:2', name: 'Screen', visibleNodeCount: 1,
        frames: [{ t: 'FRAME', n: 'Screen', id: '1:2', w: 320, h: 640 }], sets: [],
      },
      completeness: {
        requestedDepth: 0, actualDepth: 0, payloadComplete: true, depthLimited: false,
      },
    }),
  });
  assert.match(result.stdout, /Screen/);
  assert.doesNotMatch(result.stdout, /Exact copy/);
  assert.doesNotMatch(result.stdout, /depth limit/);
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

test('style projection refuses a depth-limited capture instead of inviting guesses', async () => {
  const adapter = evaluator();
  const captureDesign = async () => ({
    result: {
      id: '1:2', name: 'Screen', visibleNodeCount: 4,
      frames: [{ t: 'FRAME', n: 'Screen', id: '1:2', more: 3 }], sets: [],
    },
    completeness: {
      requestedDepth: 4, actualDepth: 4, payloadComplete: true, depthLimited: true,
    },
  });
  const structure = await executeCodeSpec({ nodeId: '1:2', phase: 'structure', depth: 4 }, {
    ...adapter, captureDesign,
  });
  assert.match(structure.stdout, /depth limit/);
  await assert.rejects(
    () => executeCodeSpec({ nodeId: '1:2', phase: 'style', depth: 4 }, { ...adapter, captureDesign }),
    /exact style contract is incomplete/i,
  );
});

test('depth-limited style error gives concrete frontier node calls', async () => {
  const adapter = evaluator();
  const captureDesign = async () => ({
    result: {
      id: '1:2', name: 'Screen', visibleNodeCount: 3,
      frames: [{
        t: 'FRAME', n: 'Screen', id: '1:2', more: 2,
        frontier: [
          { id: '1:3', name: 'Header' },
          { id: '1:4', name: 'Content' },
        ],
      }],
      sets: [],
    },
    completeness: {
      requestedDepth: 0, actualDepth: 0, payloadComplete: true, depthLimited: true,
    },
  });
  await assert.rejects(
    () => executeCodeSpec({ nodeId: '1:2', phase: 'style', depth: 0 }, {
      ...adapter, captureDesign,
    }),
    (error) => {
      assert.match(error.message, /Header \[1:3\]/);
      assert.match(error.message, /Content \[1:4\]/);
      assert.match(error.message, /depth 0/);
      return true;
    },
  );
});

test('style projection refuses unaccounted visible Figma layers even without a depth marker', async () => {
  const adapter = evaluator();
  const captureDesign = async () => ({
    result: {
      id: '1:2', name: 'Screen', visibleNodeCount: 3,
      frames: [{ t: 'FRAME', n: 'Screen', id: '1:2' }], sets: [],
    },
    completeness: {
      requestedDepth: 12, actualDepth: 12, payloadComplete: true, depthLimited: false,
    },
  });
  await assert.rejects(
    () => executeCodeSpec({ nodeId: '1:2', phase: 'style' }, { ...adapter, captureDesign }),
    /2 visible Figma layer\(s\) are unaccounted/i,
  );
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
    { nodeId: '1:2', phase: 'all', format: 'json', dedup: false },
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
