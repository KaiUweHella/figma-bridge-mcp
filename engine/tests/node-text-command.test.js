import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeText,
  executeNodeTextPlan,
  formatNodeTextResult,
  MAX_NODE_TEXT_RESULT_CODE_UNITS,
  NODE_TEXT_PREVIEW_CODE_POINTS,
  nodeTextArgvFromRequest,
  nodeTextCode,
  nodeTextPlanningArgvFromRequest,
  nodeTextPlanRoute,
  nodeTextRequestFromArgv,
  nodeTextResultRows,
} from '../src/application/node-text-command.js';
import { MAX_NODE_TEXT_INPUT_CODE_UNITS } from '../src/application/node-text-request.js';

function textNode({ id = '1:2', characters = 'Before', fonts = null, events = [] } = {}) {
  let value = characters;
  return {
    id,
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' },
    get characters() { return value; },
    set characters(next) { events.push(`write:${next}`); value = next; },
    getRangeAllFontNames() {
      return fonts || [{ family: 'Inter', style: 'Regular' }];
    },
  };
}

async function evaluateCode(code, figma) {
  return new Function('figma', `return ${code}`)(figma);
}

test('Node Text request Interface closes arity and uses -- for literal help and empty text', () => {
  assert.deepEqual(nodeTextRequestFromArgv(['node', 'set-text', '1:2', 'Hello']), {
    nodeId: '1:2', text: 'Hello',
  });
  assert.deepEqual(nodeTextRequestFromArgv(['node', 'set-text', '1:2', '--', '--help']), {
    nodeId: '1:2', text: '--help',
  });
  assert.deepEqual(nodeTextRequestFromArgv(['node', 'set-text', '--', '1:2', '-h']), {
    nodeId: '1:2', text: '-h',
  });
  assert.deepEqual(nodeTextRequestFromArgv(['node', 'set-text', '1:2', '--', '']), {
    nodeId: '1:2', text: '',
  });
  assert.deepEqual(nodeTextArgvFromRequest({ nodeId: '1:2', text: '' }), [
    'node', 'set-text', '1:2', '--', '',
  ]);
  assert.deepEqual(nodeTextArgvFromRequest({ nodeId: '1:2', text: '--help' }), [
    'node', 'set-text', '1:2', '--', '--help',
  ]);
  assert.deepEqual(nodeTextArgvFromRequest({ nodeId: '1:2', text: '-h' }), [
    'node', 'set-text', '1:2', '--', '-h',
  ]);

  for (const args of [
    ['node', 'set-text'],
    ['node', 'set-text', '1:2'],
    ['node', 'set-text', '', 'Hello'],
    ['node', 'set-text', 'not-a-node', 'Hello'],
    ['node', 'set-text', '1:2', 'Hello', 'extra'],
    ['node', 'set-text', '1:2', '--future'],
    ['node', 'set-text', '1:2', '--future', 'Hello'],
    ['node', 'set-text', '1:2', '--'],
  ]) {
    assert.throws(() => nodeTextRequestFromArgv(args), /Invalid node set-text command/, args.join(' '));
  }
  assert.throws(
    () => nodeTextRequestFromArgv(['node', 'set-text', '1:2', 42]),
    /arguments must be strings/,
  );
});

test('Node Text Adapter canonicalizes node ids but preserves a URL only for planning', () => {
  const url = 'https://www.figma.com/design/FILEA/Text-Lab?node-id=12-34';
  assert.deepEqual(nodeTextRequestFromArgv(['node', 'set-text', '12-34', 'Hello']), {
    nodeId: '12:34', text: 'Hello',
  });
  assert.deepEqual(nodeTextRequestFromArgv(['node', 'set-text', '12:34', 'Hello']), {
    nodeId: '12:34', text: 'Hello',
  });
  assert.deepEqual(nodeTextArgvFromRequest({ nodeId: url, text: 'Hello' }), [
    'node', 'set-text', '12:34', 'Hello',
  ]);
  assert.deepEqual(nodeTextPlanningArgvFromRequest({ nodeId: url, text: 'Hello' }), [
    'node', 'set-text', url, 'Hello',
  ]);
  const plan = planFigmaCommand(nodeTextPlanningArgvFromRequest({ nodeId: url, text: 'Hello' }), {
    adapter: 'mcp',
  });
  assert.equal(plan.target.fileKey, 'FILEA');
});

test('only an authentic node.set-text plan crosses the Command Application Seam once', async () => {
  const plan = planFigmaCommand(['node', 'set-text', '1:2', 'After'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.set-text');
  assert.equal(plan.allowed, true);
  assert.equal(nodeTextPlanRoute(plan), 'command-application');
  assert.equal(nodeTextPlanRoute(planFigmaCommand(['inspect', '1:2'], { adapter: 'mcp' })), 'not-node-text');
  assert.throws(() => nodeTextPlanRoute({ ...plan }), /requires a Command Plan/);

  let evaluations = 0;
  const node = textNode();
  const result = await executeNodeTextPlan(plan, {
    evaluate: async (code) => {
      evaluations += 1;
      return evaluateCode(code, {
        getNodeByIdAsync: async () => node,
        loadFontAsync: async () => {},
      });
    },
  });
  assert.equal(evaluations, 1);
  assert.deepEqual(result, { id: '1:2', oldText: 'Before', text: 'After' });
  await assert.rejects(
    () => executeNodeTextPlan(planFigmaCommand(['inspect', '1:2'], { adapter: 'mcp' }), {}),
    /is not owned by the Node Text Command Application/,
  );
});

test('generated evaluation preserves quotes, newlines and control characters without injection', async () => {
  const text = '"quote"\nline\tzero\u0000\u2028${globalThis.NODE_TEXT_INJECTED = true}';
  const oldText = 'old\n"value"\u0001';
  const node = textNode({ characters: oldText });
  const code = nodeTextCode({ nodeId: '1:2', text });
  assert.doesNotThrow(() => new Function('figma', `return ${code}`));
  delete globalThis.NODE_TEXT_INJECTED;
  const result = await evaluateCode(code, {
    getNodeByIdAsync: async () => node,
    loadFontAsync: async () => {},
  });
  assert.equal(globalThis.NODE_TEXT_INJECTED, undefined);
  assert.deepEqual(result, { id: '1:2', oldText, text });
});

test('missing and non-TEXT nodes fail before font preflight or mutation', async () => {
  for (const [node, message] of [
    [null, /Node not found: 1:2/],
    [{ id: '1:2', type: 'FRAME' }, /Not a TEXT node: FRAME/],
  ]) {
    let fontLoads = 0;
    await assert.rejects(() => executeNodeText({ nodeId: '1:2', text: 'After' }, {
      evaluate: (code) => evaluateCode(code, {
        getNodeByIdAsync: async () => node,
        loadFontAsync: async () => { fontLoads += 1; },
      }),
    }), message);
    assert.equal(fontLoads, 0);
  }
});

test('every unique mixed font settles before characters are written', async () => {
  const events = [];
  const fonts = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Inter', style: 'Bold' },
    { family: 'Inter', style: 'Regular' },
  ];
  const releases = new Map();
  const node = textNode({ fonts, events });
  const pending = executeNodeText({ nodeId: '1:2', text: 'After' }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async () => node,
      loadFontAsync: (font) => {
        const key = `${font.family}/${font.style}`;
        events.push(`start:${key}`);
        return new Promise((resolve) => { releases.set(key, resolve); })
          .then(() => { events.push(`done:${key}`); });
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start:Inter/Regular', 'start:Inter/Bold']);
  releases.get('Inter/Regular')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start:Inter/Regular', 'start:Inter/Bold', 'done:Inter/Regular']);
  releases.get('Inter/Bold')();
  const result = await pending;
  assert.deepEqual(events, [
    'start:Inter/Regular', 'start:Inter/Bold',
    'done:Inter/Regular', 'done:Inter/Bold', 'write:After',
  ]);
  assert.deepEqual(result, { id: '1:2', oldText: 'Before', text: 'After' });
});

test('a font failure waits for all preflight work and never writes', async () => {
  const events = [];
  let releaseSlow;
  const node = textNode({
    fonts: [
      { family: 'Broken', style: 'Regular' },
      { family: 'Slow', style: 'Regular' },
    ],
    events,
  });
  let settled = false;
  const pending = executeNodeText({ nodeId: '1:2', text: 'After' }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async () => node,
      loadFontAsync: async (font) => {
        events.push(`start:${font.family}`);
        if (font.family === 'Broken') throw new Error('font unavailable');
        await new Promise((resolve) => { releaseSlow = resolve; });
        events.push('done:Slow');
      },
    }),
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(events, ['start:Broken', 'start:Slow']);
  releaseSlow();
  await assert.rejects(pending, /font unavailable/);
  assert.deepEqual(events, ['start:Broken', 'start:Slow', 'done:Slow']);
  assert.equal(node.characters, 'Before');
});

test('Node Text rejects invalid bounded results and oversized input', async () => {
  const cases = [
    null,
    [],
    { id: '1:2', oldText: 'Before' },
    { id: 'unsafe\n', oldText: 'Before', text: 'After' },
    { id: '1:2', oldText: 'Before', text: 'Different' },
    { id: '2:3', oldText: 'Before', text: 'After' },
    { id: '1:2', oldText: 'Before', text: 'After', extra: true },
    { id: '1:2', oldText: 'x'.repeat(MAX_NODE_TEXT_RESULT_CODE_UNITS), text: 'After' },
  ];
  for (const value of cases) {
    let evaluations = 0;
    await assert.rejects(() => executeNodeText({ nodeId: '1:2', text: 'After' }, {
      evaluate: async () => { evaluations += 1; return value; },
    }), /Node Text returned/);
    assert.equal(evaluations, 1);
  }

  let evaluated = false;
  await assert.rejects(() => executeNodeText({ nodeId: 'not-a-node', text: 'After' }, {
    evaluate: async () => { evaluated = true; },
  }), /must be a Figma node id/);
  assert.equal(evaluated, false);

  await assert.rejects(() => executeNodeText({
    nodeId: '1:2', text: 'x'.repeat(MAX_NODE_TEXT_INPUT_CODE_UNITS + 1),
  }, {
    evaluate: async () => { evaluated = true; },
  }), /at most/);
  assert.equal(evaluated, false);

  await assert.rejects(
    () => executeNodeText({ nodeId: '1:2', text: 'After' }, {
      evaluate: async () => ({ id: '2:3', oldText: 'Before', text: 'After' }),
    }),
    (error) => error.kind === 'plugin-result'
      && error.phase === 'plugin-response'
      && error.outcome === 'unknown-after-dispatch',
  );
});

test('combined result transport bound stops before font preflight or mutation', async () => {
  const events = [];
  const node = textNode({
    characters: 'x'.repeat(MAX_NODE_TEXT_RESULT_CODE_UNITS - 4),
    events,
  });
  await assert.rejects(() => executeNodeText({ nodeId: '1:2', text: 'After' }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async () => node,
      loadFontAsync: async () => { events.push('font'); },
    }),
  }), /bounded result limit/);
  assert.deepEqual(events, []);
  assert.equal(node.characters.length, MAX_NODE_TEXT_RESULT_CODE_UNITS - 4);
});

test('presentation rows escape controls, bound previews and preserve the exact value result', () => {
  const result = {
    id: '1:2',
    oldText: `old\n\t\u2028${'a'.repeat(NODE_TEXT_PREVIEW_CODE_POINTS + 40)}`,
    text: `new\u0000\u2029${'😀'.repeat(NODE_TEXT_PREVIEW_CODE_POINTS + 40)}`,
  };
  const before = structuredClone(result);
  const rows = nodeTextResultRows(result);
  const output = formatNodeTextResult(result);
  assert.deepEqual(result, before);
  assert.deepEqual(rows[0], {
    tone: 'plain', marker: '✓', markerTone: 'success',
    text: rows[0].text,
  });
  assert.equal(output, `✓ ${rows[0].text}`);
  assert.match(output, /\\n\\t/);
  assert.match(output, /\\u0000/);
  assert.match(output, /\\u2028/);
  assert.match(output, /\\u2029/);
  assert.match(output, /…/);
  assert.equal(output.includes('\n'), false);
  assert.equal(output.includes('\u0000'), false);
  assert.ok(output.length < 600);
});
