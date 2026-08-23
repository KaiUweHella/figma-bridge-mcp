// The plugin and the daemon agree on three things that live in three different
// files and are enforced by two different systems:
//
//   engine/src/lib/daemon-port.js  PORT_RANGE   — where the daemon may bind
//   plugin/ui.html                 PORTS        — where the panel scans
//   plugin/manifest.json           allowedDomains — what Figma will PERMIT
//
// The manifest is the hard one: Figma enforces it, so a port the daemon binds
// but the manifest omits is simply unreachable — and the symptom is an endless
// "Scanning…", not an error anyone can act on. Nothing at runtime notices the
// mismatch, so it is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { PORT_RANGE, DEFAULT_PORT } from '../engine/src/lib/daemon-port.js';
import { DESIGN_ENTITY_PLUGIN_DATA_KEY } from '../engine/src/lib/design-link-registry.js';
import { randomUUID } from 'node:crypto';
import { createPreparedDispatchReceipt } from '../engine/src/lib/dispatch-receipt.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'manifest.json'), 'utf8'));
const UI = readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8');
const PLUGIN_CODE = readFileSync(join(ROOT, 'plugin', 'code.js'), 'utf8');

function uiPorts() {
  const m = UI.match(/const PORTS = \[([^\]]+)\]/);
  assert.ok(m, 'ui.html must declare a PORTS array');
  return m[1].split(',').map((s) => parseInt(s.trim(), 10));
}

test('the panel scans exactly the ports the daemon may bind', () => {
  assert.deepEqual(uiPorts(), [...PORT_RANGE]);
  assert.equal(PORT_RANGE[0], DEFAULT_PORT, 'the default port must lead the range');
});

test('the manifest permits every port in the range and nothing beyond loopback', () => {
  for (const list of [
    manifest.networkAccess.allowedDomains,
    manifest.networkAccess.devAllowedDomains,
  ]) {
    assert.ok(Array.isArray(list), 'both allowedDomains lists must exist');
    for (const port of PORT_RANGE) {
      assert.ok(
        list.includes(`ws://localhost:${port}`),
        `manifest is missing ws://localhost:${port} — the daemon could bind a port Figma blocks`,
      );
      assert.ok(
        list.includes(`http://localhost:${port}`),
        `manifest is missing http://localhost:${port} — quiet plugin discovery could be blocked`,
      );
    }
    // The whole security claim of the manifest is that the plugin cannot reach
    // anything but our loopback daemon. A wildcard or any external host here
    // would silently reopen exfiltration.
    for (const entry of list) {
      assert.match(
        entry,
        /^(?:ws|http):\/\/localhost(:\d+)?$/,
        `manifest entry "${entry}" is not an approved loopback origin`,
      );
    }
  }
});

test('the manifest keeps the plugin scoped to the editors we actually support', () => {
  // Every non-Design editor listed here has a guarded command group. "dev"
  // remains absent: an editorType we do not handle would offer a dead plugin.
  assert.deepEqual(manifest.editorType, ['figma', 'figjam', 'slides']);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.equal(manifest.enableProposedApi, false);
  assert.equal(manifest.main, 'code.js');
  assert.equal(manifest.ui, 'ui.html');
  assert.equal(manifest.id, 'figma-bridge-mcp');
});

test('Dev Mode exposes a connectable read-only Inspect adapter', () => {
  const devManifestPath = join(ROOT, 'plugin', 'manifest.dev.json');
  assert.ok(existsSync(devManifestPath), 'plugin/manifest.dev.json must ship for the connected Dev Mode workflow');
  const devManifest = JSON.parse(readFileSync(devManifestPath, 'utf8'));
  assert.deepEqual(devManifest.editorType, ['dev']);
  assert.deepEqual(devManifest.capabilities, ['inspect']);
  assert.equal(devManifest.main, 'code.js');
  assert.equal(devManifest.ui, 'ui.html');
  assert.equal(devManifest.id, 'figma-bridge-mcp-dev');
  assert.deepEqual(devManifest.networkAccess.allowedDomains, manifest.networkAccess.allowedDomains);
  assert.deepEqual(devManifest.networkAccess.devAllowedDomains, manifest.networkAccess.devAllowedDomains);
  assert.match(PLUGIN_CODE, /Figma Dev Mode is read-only\. Switch to Design mode/);
});

test('selection snapshots expose the shared Design Entity identity', () => {
  assert.match(PLUGIN_CODE, new RegExp(`DESIGN_ENTITY_STORAGE = '${DESIGN_ENTITY_PLUGIN_DATA_KEY}'`));
  assert.match(PLUGIN_CODE, /getPluginData\(DESIGN_ENTITY_STORAGE\)/);
  assert.match(PLUGIN_CODE, /entry\.entityId = link\.id/);
  assert.match(PLUGIN_CODE, /entry\.entityKind = link\.kind/);
});

test('Semantic Render Plans cross UI and main plugin threads without becoming code', () => {
  assert.match(UI, /msg\.action === 'render-plan'/);
  assert.match(UI, /type: 'render-plan', id: msg\.id, plan: msg\.plan/);
  assert.match(PLUGIN_CODE, /msg\.type === 'render-plan'/);
  assert.match(PLUGIN_CODE, /executeStructuredRenderPlan\(figma, plan\)/);
  assert.doesNotMatch(UI, /type: 'render-plan'[^\n]+code:/);
});

test('execution deadlines cross the UI boundary for every write protocol', () => {
  assert.match(UI, /const PLUGIN_CAPABILITIES = Object\.freeze\(\[[\s\S]*?'execution-deadline-v1'[\s\S]*?'render-plan-batch-v1'[\s\S]*?'render-plan-v1'[\s\S]*?\]\)/);
  assert.match(UI, /capabilities: PLUGIN_CAPABILITIES/);
  assert.match(
    UI,
    /type: 'eval', id: msg\.id, code: msg\.code,[\s\S]*?timeoutMs: msg\.timeoutMs,[\s\S]*?deadlineAt: msg\.deadlineAt,[\s\S]*?requireDocumentRevision/,
  );
  assert.match(
    UI,
    /type: 'render-plan', id: msg\.id, plan: msg\.plan, timeoutMs: msg\.timeoutMs, deadlineAt: msg\.deadlineAt/,
  );
  assert.match(
    UI,
    /type: 'render-plan-batch', id: msg\.id, plans: msg\.plans, options: msg\.options \|\| \{\}, timeoutMs: msg\.timeoutMs, deadlineAt: msg\.deadlineAt/,
  );
  assert.match(
    PLUGIN_CODE,
    /msg\.type === 'eval'[\s\S]*?remainingExecutionBudget\(timeoutMs, queuedAt, deadlineAt\)[\s\S]*?executeCode\(code, remainingMs,/,
  );
  assert.match(
    PLUGIN_CODE,
    /msg\.type === 'render-plan'[\s\S]*?remainingExecutionBudget\(timeoutMs, queuedAt, deadlineAt\)[\s\S]*?executeStructuredRenderPlan\(figma, plan\)/,
  );
  assert.match(
    PLUGIN_CODE,
    /msg\.type === 'render-plan-batch'[\s\S]*?remainingExecutionBudget\(timeoutMs, queuedAt, deadlineAt\)[\s\S]*?executeStructuredRenderPlanBatch\(figma, plans, options \|\| \{\}\)/,
  );
});

test('Plugin main replays exact lane settlement after an authenticated UI reconnect', () => {
  assert.match(UI, /'write-lane-v1'/);
  assert.match(UI, /msg\.type === 'lane-settled'[\s\S]*?ws\.send\(JSON\.stringify\(\{ type: 'lane-settled', dispatchReceipt: msg\.dispatchReceipt \}\)\)/);
  assert.match(PLUGIN_CODE, /function postLaneSettled\(msg, state, reason = null\)/);
  assert.match(PLUGIN_CODE, /replayableLaneSettlement = dispatchReceipt/);
  assert.match(PLUGIN_CODE, /msg\.type === 'connected'[\s\S]*?if \(replayableLaneSettlement\)/);
});

test('old daemons intentionally retain the bounded 22s Plugin compatibility budget', () => {
  const start = PLUGIN_CODE.indexOf('function remainingExecutionBudget(');
  const end = PLUGIN_CODE.indexOf('// Generated runtime:', start);
  assert.ok(start > 0 && end > start, 'Plugin deadline helper must stay before the generated runtime');
  const source = PLUGIN_CODE.slice(start, end);
  const remainingExecutionBudget = new Function(
    'Date',
    `${source}; return remainingExecutionBudget;`,
  )({ now: () => 1_000 });

  // 22,000ms total minus its 1% response margin. `undefined` is what an older
  // daemon sends when it does not know the deadline field yet.
  assert.equal(remainingExecutionBudget(undefined, 1_000), 21_780);
  assert.match(PLUGIN_CODE, /async function executeCode\(code, timeoutMs = 22000, onTimeout = null\)/);
});

test('expired queued writes never begin and timed-out evals quarantine the Plugin lane', async () => {
  const posted = [];
  let createdFrames = 0;
  let releaseBlocker;
  const blocker = new Promise((resolve) => { releaseBlocker = resolve; });
  const hostSetTimeout = globalThis.setTimeout;
  const context = createContext({
    __html__: '',
    blocker,
    writeExecutions: 0,
    console: { log() {}, error() {} },
    clearTimeout: globalThis.clearTimeout,
    setTimeout(fn, delay, ...args) {
      const timer = hostSetTimeout(fn, delay, ...args);
      // A failed assertion must not leave a long Plugin safety timer keeping
      // the regression process alive after the useful failure is reported.
      if (delay > 100 && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    figma: {
      editorType: 'figma',
      fileKey: 'DEADLINE_FILE',
      root: { name: 'Deadline Test' },
      currentPage: { name: 'Page 1', selection: [] },
      showUI() {},
      on() {},
      createFrame() { createdFrames++; return {}; },
      notify() {},
      clientStorage: { async getAsync() { return ''; }, async setAsync() {} },
      ui: {
        onmessage: null,
        postMessage(message) { posted.push(message); },
        resize() {},
      },
    },
  });
  new Script(PLUGIN_CODE, { filename: 'plugin/code.js' }).runInContext(context);
  assert.equal(typeof context.figma.ui.onmessage, 'function');

  const connectionEpoch = randomUUID();
  const receipt = (action, overrides = {}) => createPreparedDispatchReceipt({
    requestId: randomUUID(),
    connectionEpoch,
    fileKey: 'DEADLINE_FILE',
    editorType: 'figma',
    action,
    ...overrides,
  });
  await context.figma.ui.onmessage({ type: 'connected', connectionEpoch });

  const plan = {
    kind: 'figma-bridge/semantic-render-plan',
    version: 1,
    adapter: 'jsx',
    root: {
      path: 'root',
      name: 'Should not render',
      source: { kind: 'jsx', type: 'frame', props: { name: 'Should not render' } },
      children: [],
    },
    diagnostics: {},
  };

  // Hold the serialized Plugin queue, enqueue all three write protocols with
  // a short owning deadline, then let that deadline elapse before releasing it.
  await context.figma.ui.onmessage({
    type: 'eval', id: 1, code: 'blocker', timeoutMs: 2_000, dispatchReceipt: receipt('eval'),
  });
  const deadlineAt = Date.now() + 40;
  await context.figma.ui.onmessage({
    type: 'eval', id: 2, code: '(writeExecutions += 1)', timeoutMs: 2_000, deadlineAt,
    dispatchReceipt: receipt('eval'),
  });
  await context.figma.ui.onmessage({
    type: 'render-plan', id: 3, plan, timeoutMs: 2_000, deadlineAt,
    dispatchReceipt: receipt('render-plan'),
  });
  await context.figma.ui.onmessage({
    type: 'render-plan-batch', id: 4, plans: [plan], options: {}, timeoutMs: 2_000, deadlineAt,
    dispatchReceipt: receipt('render-plan-batch'),
  });
  await new Promise((resolve) => hostSetTimeout(resolve, 80));
  releaseBlocker('released');

  const deadline = Date.now() + 1_000;
  while (posted.filter((message) => message.type === 'result').length < 4 && Date.now() < deadline) {
    await new Promise((resolve) => hostSetTimeout(resolve, 5));
  }

  const results = posted.filter((message) => message.type === 'result');
  assert.equal(results.length, 4);
  assert.equal(results.find((message) => message.id === 1)?.result, 'released');
  for (const id of [2, 3, 4]) {
    assert.match(
      results.find((message) => message.id === id)?.error || '',
      /Execution deadline elapsed before plugin start/,
    );
    assert.equal(results.find((message) => message.id === id)?.dispatchReceipt?.state, 'not-dispatched');
    assert.equal(results.find((message) => message.id === id)?.dispatchReceipt?.reason, 'deadline-elapsed');
  }
  assert.equal(context.writeExecutions, 0, 'expired eval code must not execute');
  assert.equal(createdFrames, 0, 'expired render plans must not create canvas nodes');

  let releaseSlowEval;
  context.slowEval = new Promise((resolve) => { releaseSlowEval = resolve; });
  const slowDeadlineAt = Date.now() + 90;
  await context.figma.ui.onmessage({
    type: 'eval', id: 5, code: 'slowEval', timeoutMs: 1_000, deadlineAt: slowDeadlineAt,
    dispatchReceipt: receipt('eval'),
  });
  await context.figma.ui.onmessage({
    type: 'eval', id: 6, code: '(writeExecutions += 1)', timeoutMs: 1_000, deadlineAt: Date.now() + 1_000,
    dispatchReceipt: receipt('eval'),
  });
  const timeoutWait = Date.now() + 500;
  while (!posted.find((message) => message.id === 5) && Date.now() < timeoutWait) {
    await new Promise((resolve) => hostSetTimeout(resolve, 5));
  }
  assert.match(posted.find((message) => message.id === 5)?.error || '', /Execution timeout/);
  assert.equal(posted.find((message) => message.id === 5)?.dispatchReceipt?.state, 'unknown');
  assert.equal(context.writeExecutions, 0, 'the next write must stay quarantined behind the timed-out eval');
  assert.equal(posted.some((message) => message.id === 6), false, 'the next write must not answer before the underlying eval settles');

  releaseSlowEval('late result');
  const releaseWait = Date.now() + 500;
  while (!posted.find((message) => message.id === 6) && Date.now() < releaseWait) {
    await new Promise((resolve) => hostSetTimeout(resolve, 5));
  }
  assert.equal(context.writeExecutions, 1, 'the next write may start only after the uncertain eval has actually settled');

  await context.figma.ui.onmessage({
    type: 'eval', id: 7, code: '(writeExecutions += 100)', timeoutMs: 1_000,
    dispatchReceipt: receipt('eval', { editorType: 'figjam' }),
  });
  await context.figma.ui.onmessage({
    type: 'eval', id: 8, code: '(writeExecutions += 1000)', timeoutMs: 1_000,
    dispatchReceipt: receipt('eval', { fileKey: 'OTHER_FILE' }),
  });
  const mismatchWait = Date.now() + 500;
  while ((!posted.find((message) => message.id === 7)
      || !posted.find((message) => message.id === 8))
    && Date.now() < mismatchWait) {
    await new Promise((resolve) => hostSetTimeout(resolve, 5));
  }
  assert.equal(context.writeExecutions, 1, 'editor and target mismatches must fail before eval mutation');
  assert.deepEqual(
    [7, 8].map((id) => posted.find((message) => message.id === id)?.dispatchReceipt?.state),
    ['not-dispatched', 'not-dispatched'],
  );
  assert.deepEqual(
    [7, 8].map((id) => posted.find((message) => message.id === id)?.dispatchReceipt?.reason),
    ['editor-mismatch', 'target-mismatch'],
  );

  const waitForResult = async (id) => {
    const limit = Date.now() + 500;
    while (!posted.find((message) => message.id === id) && Date.now() < limit) {
      await new Promise((resolve) => hostSetTimeout(resolve, 5));
    }
    return posted.find((message) => message.id === id);
  };
  let editorMessageId = 20;
  for (const editorType of ['figjam', 'slides', 'dev']) {
    context.figma.editorType = editorType;
    const evalId = editorMessageId++;
    await context.figma.ui.onmessage({
      type: 'eval', id: evalId, code: 'figma.editorType', timeoutMs: 1_000,
      dispatchReceipt: receipt('eval', { editorType }),
    });
    const editorResult = await waitForResult(evalId);
    assert.equal(editorResult?.result, editorType, `${editorType} eval workflow remains reachable`);
    assert.equal(editorResult?.dispatchReceipt?.state, 'completed');

    const renderId = editorMessageId++;
    await context.figma.ui.onmessage({
      type: 'render-plan', id: renderId, plan, timeoutMs: 1_000,
      dispatchReceipt: receipt('render-plan', { editorType }),
    });
    const renderResult = await waitForResult(renderId);
    assert.equal(renderResult?.dispatchReceipt?.state, 'not-dispatched');
    assert.equal(renderResult?.dispatchReceipt?.reason, 'editor-mismatch');
    assert.match(renderResult?.error || '', /Semantic Render Plans require Figma Design/);
  }
  context.figma.editorType = 'figma';
  assert.equal(createdFrames, 0, 'Design-only Render Plans must not mutate any non-Design editor');
});
