import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeRename,
  executeNodeRenamePlan,
  nodeRenameArgvFromRequest,
  nodeRenameCode,
  nodeRenamePlanRoute,
  nodeRenamePlanningArgvFromRequest,
} from '../src/application/node-rename-command.js';
import { parseNodeRenameRequest } from '../src/application/node-rename-request.js';

function fixture({
  initialName = 'Before',
  writeMode = 'normal',
  rollbackMode = 'normal',
  missing = false,
  readFailures = [],
} = {}) {
  let storedName = initialName;
  let writes = 0;
  let reads = 0;
  const node = {
    id: '3:1', type: 'FRAME',
    get name() { return storedName; },
    set name(value) {
      writes += 1;
      const rollback = value === initialName;
      if (rollback && rollbackMode === 'no-effect') return;
      if (rollback && rollbackMode === 'throw') throw new Error('injected rollback failure');
      if (!rollback && writeMode === 'no-effect') return;
      if (!rollback && writeMode === 'throw-before') throw new Error('injected setter failure');
      storedName = value;
      if (!rollback && writeMode === 'throw-after') throw new Error('injected acknowledgement failure');
    },
  };
  return {
    node,
    get name() { return storedName; },
    get writes() { return writes; },
    figma: {
      async getNodeByIdAsync(id) {
        reads += 1;
        if (readFailures.includes(reads)) throw new Error('injected readback failure');
        return id === '3:1' && !missing ? node : null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Rename request closes arity, options, literals and semantic URL targeting', () => {
  assert.deepEqual(parseNodeRenameRequest(['node', 'rename', '3-1', 'After']), {
    nodeId: '3:1', name: 'After',
  });
  assert.deepEqual(nodeRenameArgvFromRequest({ nodeId: '3:1', name: '-dash' }), [
    'node', 'rename', '3:1', '--', '-dash',
  ]);
  assert.deepEqual(nodeRenameArgvFromRequest({ nodeId: '3:1', name: '' }), [
    'node', 'rename', '3:1', '--', '',
  ]);

  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  assert.deepEqual(nodeRenamePlanningArgvFromRequest({ nodeId: url, name: 'After' }), [
    'node', 'rename', url, 'After',
  ]);
  const plan = planFigmaCommand(['node', 'rename', url, 'https://figma.com/design/FILEB/Payload'], {
    adapter: 'mcp',
  });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, [
    'node', 'rename', '3:1', 'https://figma.com/design/FILEB/Payload',
  ]);

  for (const args of [
    ['node', 'rename'],
    ['node', 'rename', '3:1'],
    ['node', 'rename', '3:1', 'After', 'extra'],
    ['node', 'rename', 'bad', 'After'],
    ['node', 'rename', '3:1', '--future'],
  ]) assert.throws(() => parseNodeRenameRequest(args));
});

test('rename performs one write and verifies the requested name through a fresh read', async () => {
  const live = fixture();
  const result = await executeNodeRename({ nodeId: '3:1', name: 'After' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(live.name, 'After');
  assert.equal(live.writes, 1);
  assert.deepEqual(result.result, {
    schemaVersion: 1, status: 'renamed', node: { id: '3:1', type: 'FRAME' },
    oldName: 'Before', name: 'After', attempted: 1, residue: [],
  });
  assert.match(result.stdout, /Renamed "Before" → "After"/);
});

test('already matching name is a verified no-op', async () => {
  const live = fixture({ initialName: 'Same' });
  const result = await executeNodeRename({ nodeId: '3:1', name: 'Same' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.attempted, 0);
  assert.equal(live.writes, 0);
});

test('a thrown setter acknowledgement is successful when fresh state matches', async () => {
  const live = fixture({ writeMode: 'throw-after' });
  const result = await executeNodeRename({ nodeId: '3:1', name: 'After' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'renamed');
  assert.equal(live.name, 'After');
  assert.equal(live.writes, 1);
});

test('failed postcondition restores the previous name exactly once', async () => {
  const live = fixture({ writeMode: 'no-effect' });
  await assert.rejects(() => executeNodeRename({ nodeId: '3:1', name: 'After' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.equal(live.name, 'Before');
  assert.equal(live.writes, 2);
});

test('failed rollback reports remaining name residue', async () => {
  const live = fixture({ writeMode: 'throw-after', rollbackMode: 'no-effect' });
  // The first thrown acknowledgement still succeeds because readback observes
  // the requested value, so use a stale first verification to reach rollback.
  live.figma.getNodeByIdAsync = (() => {
    let reads = 0;
    return async () => {
      reads += 1;
      if (reads === 2) return { id: '3:1', type: 'FRAME', name: 'Wrong' };
      return live.node;
    };
  })();
  await assert.rejects(() => executeNodeRename({ nodeId: '3:1', name: 'After' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.equal(live.name, 'After');
});

test('unavailable rollback verification is explicit', async () => {
  const live = fixture({ writeMode: 'no-effect', readFailures: [3] });
  await assert.rejects(() => executeNodeRename({ nodeId: '3:1', name: 'After' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.restored, 0);
    return true;
  });
});

test('missing target refuses before mutation', async () => {
  const live = fixture({ missing: true });
  await assert.rejects(() => executeNodeRename({ nodeId: '3:1', name: 'After' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.attempted, 0);
    return true;
  });
  assert.equal(live.writes, 0);
});

test('generated code keeps the requested name inert', () => {
  const name = '`); globalThis.NODE_RENAME_INJECTED = true; //';
  const code = nodeRenameCode({ nodeId: '3:1', name });
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.equal(globalThis.NODE_RENAME_INJECTED, undefined);
});

test('one authentic non-retrying node.rename plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(['node', 'rename', '3:1', 'After'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.rename');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeRenamePlanRoute(plan), 'command-application');
  assert.throws(() => nodeRenamePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeNodeRenamePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'renamed');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful renames', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'renamed' })]) {
    await assert.rejects(() => executeNodeRename({ nodeId: '3:1', name: 'After' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});
