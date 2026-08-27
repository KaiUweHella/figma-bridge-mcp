import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeDelete,
  executeNodeDeletePlan,
  formatNodeDeleteResult,
  nodeDeleteCode,
  nodeDeletePlanRoute,
} from '../src/application/node-delete-command.js';
import {
  acceptsNodeDeleteArgv,
  nodeDeleteArgvFromRequest,
  nodeDeleteFigmaUrlFileKeyFromArgv,
  nodeDeletePlanningArgvFromRequest,
  parseNodeDeleteRequest,
} from '../src/application/node-delete-request.js';

async function evaluateCode(code, figma) {
  return new Function('figma', `return ${code}`)(figma);
}

function container(id, type = 'FRAME') {
  return { id, type, children: [], parent: null };
}

function pageHierarchy() {
  const document = container('0:0', 'DOCUMENT');
  const page = container('0:1', 'PAGE');
  page.parent = document;
  document.children.push(page);
  return { document, page };
}

function removableNode(id, parent, events = []) {
  const node = {
    id,
    type: 'FRAME',
    parent,
    children: [],
    remove() {
      events.push(id);
      const index = this.parent.children.findIndex((child) => child.id === this.id);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    },
  };
  parent.children.push(node);
  return node;
}

test('Node Delete request closes all target identities without losing URL targeting', () => {
  const url = 'https://www.figma.com/design/FILEA/Delete-Lab?node-id=12-34';
  assert.deepEqual(parseNodeDeleteRequest(['node', 'delete', '1-2', '3:4']), {
    nodeIds: ['1:2', '3:4'],
  });
  assert.deepEqual(nodeDeleteArgvFromRequest({ nodeIds: ['1-2', '3:4'] }), [
    'node', 'delete', '1:2', '3:4',
  ]);
  assert.deepEqual(nodeDeletePlanningArgvFromRequest({ nodeIds: [url, '3:4'] }), [
    'node', 'delete', url, '3:4',
  ]);
  assert.equal(nodeDeleteFigmaUrlFileKeyFromArgv(['node', 'delete', url]), 'FILEA');
  assert.equal(acceptsNodeDeleteArgv(['node', 'delete', '1:2']), true);
  for (const argv of [
    ['node', 'delete'],
    ['node', 'delete', '--future'],
    ['node', 'delete', '1:2', '1-2'],
    ['node', 'delete', 'not-a-node'],
  ]) assert.equal(acceptsNodeDeleteArgv(argv), false, argv.join(' '));
  assert.throws(
    () => nodeDeleteFigmaUrlFileKeyFromArgv([
      'node', 'delete',
      url,
      'https://www.figma.com/design/FILEB/Delete-Lab?node-id=3-4',
    ]),
    /multiple Figma files/,
  );
});

test('Node Delete verifies former-parent membership and retains input-order outcomes', async () => {
  const events = [];
  const { page } = pageHierarchy();
  const parent = removableNode('1:2', page, events);
  const child = removableNode('1:3', parent, events);
  const nodes = new Map([[parent.id, parent], [child.id, child]]);

  const result = await executeNodeDelete({ nodeIds: [parent.id, child.id, '9:9'] }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async (id) => nodes.get(id) || null,
    }),
  });

  assert.deepEqual(events, [child.id, parent.id], 'nested targets must be removed deepest-first');
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'completed',
    removed: 2,
    alreadyDetached: 0,
    notFound: 1,
    targets: [
      { id: parent.id, status: 'removed', parentId: page.id },
      { id: child.id, status: 'removed', parentId: parent.id },
      { id: '9:9', status: 'not-found', parentId: null },
    ],
  });
  assert.match(formatNodeDeleteResult(result), /Removed 2 node\(s\); 0 already detached; 1 not found/);
  assert.equal(page.children.length, 0);
});

test('Node Delete treats retained and stale direct handles as detached without mutating them', async () => {
  let detachedRemoveCalls = 0;
  const { page: staleParent } = pageHierarchy();
  const retained = {
    id: '1:2', type: 'FRAME', parent: null, children: [],
    remove() { detachedRemoveCalls += 1; },
  };
  const stale = {
    id: '1:3', type: 'FRAME', parent: staleParent, children: [],
    remove() { detachedRemoveCalls += 1; },
  };
  const retainedSet = {
    id: '1:4', type: 'COMPONENT_SET', parent: null, children: [],
  };
  const retainedVariant = {
    id: '1:5', type: 'COMPONENT', parent: retainedSet, children: [],
    remove() { detachedRemoveCalls += 1; },
  };
  retainedSet.children.push(retainedVariant);
  const nodes = new Map([
    [retained.id, retained], [stale.id, stale], [retainedVariant.id, retainedVariant],
  ]);
  const result = await executeNodeDelete({
    nodeIds: [retained.id, stale.id, retainedVariant.id],
  }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async (id) => nodes.get(id) || null,
    }),
  });

  assert.equal(detachedRemoveCalls, 0);
  assert.deepEqual(result.targets, [
    { id: retained.id, status: 'already-detached', parentId: null },
    { id: stale.id, status: 'already-detached', parentId: staleParent.id },
    { id: retainedVariant.id, status: 'already-detached', parentId: retainedSet.id },
  ]);
  assert.equal(result.removed, 0);
  assert.equal(result.alreadyDetached, 3);
});

test('repeating Node Delete never claims a retained handle twice', async () => {
  const { page } = pageHierarchy();
  let removeCalls = 0;
  const node = removableNode('1:2', page);
  const nativeRemove = node.remove.bind(node);
  node.remove = () => { removeCalls += 1; nativeRemove(); };
  const figma = { getNodeByIdAsync: async () => node };

  const first = await executeNodeDelete({ nodeIds: [node.id] }, {
    evaluate: (code) => evaluateCode(code, figma),
  });
  const second = await executeNodeDelete({ nodeIds: [node.id] }, {
    evaluate: (code) => evaluateCode(code, figma),
  });

  assert.equal(first.targets[0].status, 'removed');
  assert.equal(second.targets[0].status, 'already-detached');
  assert.equal(second.removed, 0);
  assert.equal(removeCalls, 1);
});

test('Node Delete refuses success when the former parent still contains the target', async () => {
  const { page } = pageHierarchy();
  const node = {
    id: '1:2', type: 'FRAME', parent: page, children: [],
    remove() {},
  };
  page.children.push(node);
  await assert.rejects(
    () => executeNodeDelete({ nodeIds: [node.id] }, {
      evaluate: (code) => evaluateCode(code, { getNodeByIdAsync: async () => node }),
    }),
    /former parent still contains the target/,
  );
});

test('Node Delete failure reports already-confirmed earlier effects in the batch', async () => {
  const { page } = pageHierarchy();
  const first = removableNode('1:2', page);
  const second = {
    id: '1:3', type: 'FRAME', parent: page, children: [],
    remove() {},
  };
  page.children.push(second);
  const nodes = new Map([[first.id, first], [second.id, second]]);
  await assert.rejects(
    () => executeNodeDelete({ nodeIds: [first.id, second.id] }, {
      evaluate: (code) => evaluateCode(code, {
        getNodeByIdAsync: async (id) => nodes.get(id) || null,
      }),
    }),
    /after 1 confirmed removal\(s\)/,
  );
  assert.equal(page.children.some((node) => node.id === first.id), false);
  assert.equal(page.children.some((node) => node.id === second.id), true);
});

test('Node Delete routing accepts only its authentic non-retrying Command Plan', async () => {
  const plan = planFigmaCommand(['node', 'delete', '1-2'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeDeletePlanRoute(plan), 'command-application');
  assert.equal(nodeDeletePlanRoute(planFigmaCommand(['node', 'tree'])), 'not-node-delete');
  assert.throws(() => nodeDeletePlanRoute({ ...plan }), /requires a Command Plan/);

  const { page } = pageHierarchy();
  const node = removableNode('1:2', page);
  let evaluations = 0;
  const result = await executeNodeDeletePlan(plan, {
    evaluate: async (code) => {
      evaluations += 1;
      return evaluateCode(code, { getNodeByIdAsync: async () => node });
    },
  });
  assert.equal(evaluations, 1);
  assert.equal(result.targets[0].status, 'removed');
});

test('Node Delete generated evaluation is injection-safe and rejects malformed Plugin results', async () => {
  const code = nodeDeleteCode({ nodeIds: ['1:2'] });
  assert.doesNotThrow(() => new Function('figma', `return ${code}`));
  await assert.rejects(
    () => executeNodeDelete({ nodeIds: ['1:2'] }, { evaluate: async () => ({ removed: 1 }) }),
    /invalid bounded result/,
  );
});
