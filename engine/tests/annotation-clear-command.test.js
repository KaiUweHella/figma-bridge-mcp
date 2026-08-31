import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationClearCode,
  annotationClearPlanRoute,
  annotationClearPlanningArgvFromRequest,
  executeAnnotationClear,
  executeAnnotationClearPlan,
} from '../src/application/annotation-clear-command.js';
import {
  acceptsAnnotationClearArgv,
  annotationClearArgvFromRequest,
  annotationClearFigmaUrlFileKeyFromArgv,
  parseAnnotationClearRequest,
} from '../src/application/annotation-clear-request.js';

const BEFORE = Object.freeze([
  { label: 'Review', categoryId: 'C:1', properties: [{ type: 'width' }] },
  { labelMarkdown: '**Ready**' },
]);

function clone(values) {
  return values.map((annotation) => ({
    ...annotation,
    ...(annotation.properties
      ? { properties: annotation.properties.map((property) => ({ ...property })) }
      : {}),
  }));
}

function fixture({
  initial = BEFORE,
  writeMode = 'normal',
  rollbackMode = 'normal',
  missing = false,
  readFailures = [],
} = {}) {
  let stored = clone(initial);
  let writes = 0;
  let reads = 0;
  const node = {
    id: '1:2', name: 'Card', type: 'FRAME',
    get annotations() { return clone(stored); },
    set annotations(value) {
      writes += 1;
      const rollback = value.length > 0;
      if (rollback && rollbackMode === 'no-effect') return;
      if (rollback && rollbackMode === 'throw-before') throw new Error('injected rollback failure');
      if (!rollback && writeMode === 'no-effect') return;
      if (!rollback && writeMode === 'throw-before') throw new Error('injected clear failure');
      stored = !rollback && writeMode === 'partial' ? [{ label: 'Residue' }] : clone(value);
      if (!rollback && writeMode === 'throw-after') throw new Error('injected acknowledgement failure');
    },
  };
  return {
    node,
    get annotations() { return clone(stored); },
    get writes() { return writes; },
    figma: {
      async getNodeByIdAsync(nodeId) {
        reads += 1;
        if (readFailures.includes(reads)) throw new Error('injected readback failure');
        return nodeId === node.id && !missing ? node : null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Annotation Clear closes one exact node and URL target identity', () => {
  assert.deepEqual(parseAnnotationClearRequest(['annotate', 'clear', '1-2']), {
    nodeId: '1:2',
  });
  assert.deepEqual(annotationClearArgvFromRequest({ nodeId: '1-2' }), [
    'annotate', 'clear', '1:2',
  ]);
  for (const argv of [
    ['annotate', 'clear'],
    ['annotate', 'clear', '1:2', '1:3'],
    ['annotate', 'clear', '--future'],
    ['annotate', 'clear', 'not-a-node'],
  ]) assert.equal(acceptsAnnotationClearArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Annotation-Lab?node-id=1-2';
  const planning = annotationClearPlanningArgvFromRequest({ nodeId: url });
  assert.equal(annotationClearFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['annotate', 'clear', '1:2']);
});

test('Annotation Clear snapshots, clears once, and freshly verifies the empty state', async () => {
  const live = fixture();
  const result = await executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(live.annotations, []);
  assert.equal(live.writes, 1);
  assert.deepEqual(result.result, {
    schemaVersion: 1,
    status: 'cleared',
    outcome: 'verified',
    node: { id: '1:2', name: 'Card', type: 'FRAME' },
    cleared: 2,
    attempted: 1,
    residue: [],
    warnings: [],
  });
  assert.equal(result.stdout, '✓ Cleared annotations on Card (1:2)');
});

test('already empty is a verified no-op', async () => {
  const live = fixture({ initial: [] });
  const result = await executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.attempted, 0);
  assert.equal(result.result.cleared, 0);
  assert.equal(live.writes, 0);
});

test('a thrown native acknowledgement succeeds only after fresh empty readback', async () => {
  const live = fixture({ writeMode: 'throw-after' });
  const result = await executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.deepEqual(live.annotations, []);
});

test('a no-effect mutation reports unchanged without a destructive retry', async () => {
  const live = fixture({ writeMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'unchanged');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'unchanged', attempted: 1, restored: 0, residueCount: 1,
    });
    return true;
  });
  assert.deepEqual(live.annotations, BEFORE);
  assert.equal(live.writes, 1);
});

test('a partial postcondition restores the exact bounded snapshot once', async () => {
  const live = fixture({ writeMode: 'partial' });
  await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.deepEqual(live.annotations, BEFORE);
  assert.equal(live.writes, 2);
});

test('failed rollback and unavailable verification retain explicit residue semantics', async () => {
  const partial = fixture({ writeMode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(partial.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.deepEqual(partial.annotations, [{ label: 'Residue' }]);

  const unavailable = fixture({
    writeMode: 'partial', rollbackMode: 'no-effect', readFailures: [4],
  });
  await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
});

test('missing and malformed preflight state refuses before mutation', async () => {
  const missing = fixture({ missing: true });
  await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(missing.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.attempted, 0);
    return true;
  });
  assert.equal(missing.writes, 0);

  const malformed = fixture({ initial: [{ properties: [{ type: 'future' }] }] });
  await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
    evaluate: evaluate(malformed.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(malformed.writes, 0);
});

test('one authentic non-retrying clear Plan crosses the CLI and MCP Application seam', async () => {
  const cli = planFigmaCommand(['annotate', 'clear', '1-2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'clear', '1:2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(annotationClearPlanRoute(cli), 'command-application');
  assert.throws(() => annotationClearPlanRoute({ ...cli }), /requires a Command Plan/);
  const live = fixture();
  const result = await executeAnnotationClearPlan(cli, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'cleared');
  assert.equal(annotationClearPlanRoute(
    planFigmaCommand(['annotate', 'list', '1:2'], { adapter: 'mcp' }),
  ), 'not-annotation-clear');
});

test('malformed Plugin results cannot become successful clears', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'cleared' })]) {
    await assert.rejects(() => executeAnnotationClear({ nodeId: '1:2' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('Annotation Clear generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${annotationClearCode({ nodeId: '1:2' })}`));
});
