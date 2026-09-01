import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { normalizeSnapshot } from '../src/lib/doc-snapshot.js';
import {
  executeHistory,
  executeHistoryPlan,
  historyPlanRoute,
  historyPlanningArgvFromRequest,
} from '../src/application/history-command.js';
import {
  acceptsHistoryArgv,
  historyArgvFromRequest,
  parseHistoryRequest,
} from '../src/application/history-request.js';

function raw(text = 'Hello') {
  return {
    fileKey: 'FILE', fileName: 'Fixture', page: 'Page',
    rootId: '1:1', rootName: 'Root',
    nodes: [{
      id: '1:1', name: 'Root', type: 'FRAME', path: 'Root', parentId: null,
      index: 0, x: 0, y: 0, w: 100, h: 100, props: { characters: text },
    }],
  };
}

function fakeStore(savedSnapshot = normalizeSnapshot(raw(), { takenAt: '2026-08-01T10:00:00.000Z' })) {
  const ref = Object.freeze({ file: '2026-08-01T10-00-00-000Z.json.gz', bytes: 120 });
  const saves = [];
  return {
    saves,
    directory: () => '/private/snapshots/FILE',
    save: (snapshot) => {
      saves.push(snapshot);
      return {
        file: '2026-08-01T11-00-00-000Z.json.gz',
        path: '/private/snapshots/FILE/new.json.gz', bytes: 160, pruned: [],
      };
    },
    list: () => [ref],
    resolve: (value) => value === 'latest' || value === 'previous' ? ref : null,
    read: (value) => {
      assert.equal(value, ref);
      return savedSnapshot;
    },
  };
}

const evaluate = async (code) => code === '(async () => figma.fileKey || null)()' ? 'FILE' : raw('Changed');

test('History request closes and canonicalizes save, snapshot, list, and diff', () => {
  assert.deepEqual(parseHistoryRequest([
    'history', 'save', '--description= ready ', '--', '--release',
  ]), {
    action: 'save', title: '--release', description: 'ready',
  });
  assert.deepEqual(parseHistoryRequest([
    'history', 'snapshot', '--label=Before', '--depth', '2', '--node', '1-2', '--json',
  ]), {
    action: 'snapshot', nodeId: '1:2', depth: 2, label: 'Before', format: 'json',
  });
  assert.deepEqual(parseHistoryRequest(['history', 'list']), { action: 'list' });
  assert.deepEqual(historyArgvFromRequest({
    action: 'diff', to: 'live', from: 'latest', maxItems: 12, format: 'text',
  }), ['history', 'diff', 'latest', 'live', '--max-items', '12']);
  assert.deepEqual(historyPlanningArgvFromRequest({
    action: 'diff', from: 'latest', to: 'live',
    nodeId: 'https://www.figma.com/design/ABC/File?node-id=1-2',
  }), ['history', 'diff', 'latest', 'live', '--node', 'https://www.figma.com/design/ABC/File?node-id=1-2']);
  for (const argv of [
    ['history', 'list', 'extra'],
    ['history', 'snapshot', '--depth', '-1'],
    ['history', 'snapshot', '--unknown'],
    ['history', 'diff', 'a', 'b', 'c'],
    ['history', 'diff', 'latest', 'live', '--json', '--changelog'],
    ['history', 'save'],
    ['history', 'save', 'Title', 'Extra'],
    ['history', 'save', 'Title', '--description', 'a', '-d', 'b'],
  ]) assert.equal(acceptsHistoryArgv(argv), false, argv.join(' '));
});

test('History snapshot preserves JSON-only and private-save utility', async () => {
  const store = fakeStore();
  const json = await executeHistory({
    action: 'snapshot', nodeId: '', depth: null, label: 'Preview', format: 'json',
  }, { evaluate, store });
  assert.equal(store.saves.length, 0);
  assert.equal(JSON.parse(json.stdout).label, 'Preview');

  const saved = await executeHistory({
    action: 'snapshot', nodeId: '', depth: null, label: null, format: 'save',
  }, { evaluate, store });
  assert.equal(store.saves.length, 1);
  assert.match(saved.stdout, /Snapshot saved/);
  assert.match(saved.stdout, /ref: 2026-08-01T11-00-00-000Z\.json\.gz/);
  assert.doesNotMatch(saved.stdout, /\/private\/snapshots|FILE/);
  assert.deepEqual(saved.result.saved, {
    ref: '2026-08-01T11-00-00-000Z.json.gz', bytes: 160, pruned: [],
  });
  assert.match(saved.stdout, /Diff against it later/);
  await assert.rejects(
    () => executeHistory({ action: 'snapshot', format: 'yaml' }, { evaluate, store }),
    /format must be one of save, json/,
  );
});

test('History list and diff share one Store and value-returning application', async () => {
  const store = fakeStore();
  const listed = await executeHistory({ action: 'list' }, { evaluate, store });
  assert.match(listed.stdout, /1 snapshot\(s\)/);
  assert.match(listed.stdout, /2026-08-01/);
  assert.doesNotMatch(listed.stdout, /\/private\/snapshots|FILE/);

  const diffed = await executeHistory({
    action: 'diff', from: 'latest', to: 'live', nodeId: '', depth: null,
    format: 'text', changelogPath: null, maxItems: 40,
  }, { evaluate, store });
  assert.equal(diffed.code, 1);
  assert.match(diffed.stdout, /changed/i);
});

test('History changelog persistence uses the Plan-owned Workspace path', async () => {
  const store = fakeStore();
  const writes = [];
  const plan = planFigmaCommand([
    'history', 'diff', 'latest', 'live', '--changelog', '/work/change.md',
  ], { adapter: 'cli', workspaceDir: '/work' });
  assert.equal(historyPlanRoute(plan), 'command-application');
  const result = await executeHistoryPlan(plan, {
    evaluate,
    store,
    workspaceIO: { write: (...args) => writes.push(args) },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(writes.map(([path]) => path), ['/work/change.md']);
  assert.match(writes[0][1], /^# Design changes/m);
});

test('History Plan route rejects non-History and non-authentic objects', () => {
  const plan = planFigmaCommand(['history', 'list'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(historyPlanRoute(plan), 'command-application');
  assert.throws(() => historyPlanRoute({ ...plan }), /created by the Capability Catalog/);
  assert.equal(historyPlanRoute(planFigmaCommand(['inspect', '1:2'], { adapter: 'cli' })), 'not-history');
});
