import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationRemoveCode,
  annotationRemovePlanRoute,
  annotationRemovePlanningArgvFromRequest,
  executeAnnotationRemove,
  executeAnnotationRemovePlan,
} from '../src/application/annotation-remove-command.js';
import {
  acceptsAnnotationRemoveArgv,
  annotationRemoveArgvFromRequest,
  annotationRemoveFigmaUrlFileKeyFromArgv,
  parseAnnotationRemoveRequest,
} from '../src/application/annotation-remove-request.js';

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
      const rollback = value.length === initial.length;
      if (rollback && rollbackMode === 'no-effect') return;
      if (rollback && rollbackMode === 'throw-before') throw new Error('injected rollback failure');
      if (!rollback && writeMode === 'no-effect') return;
      if (!rollback && writeMode === 'throw-before') throw new Error('injected remove failure');
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

test('Annotation Remove closes node, zero-based index, arity, and URL identity', () => {
  assert.deepEqual(parseAnnotationRemoveRequest(['annotate', 'remove', '1-2', '01']), {
    nodeId: '1:2', index: 1,
  });
  assert.deepEqual(annotationRemoveArgvFromRequest({ nodeId: '1-2', index: '1e0' }), [
    'annotate', 'remove', '1:2', '1',
  ]);
  for (const argv of [
    ['annotate', 'remove'],
    ['annotate', 'remove', '1:2'],
    ['annotate', 'remove', '1:2', '-1'],
    ['annotate', 'remove', '1:2', '1.5'],
    ['annotate', 'remove', '1:2', '0', 'extra'],
    ['annotate', 'remove', 'not-a-node', '0'],
  ]) assert.equal(acceptsAnnotationRemoveArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Annotation-Lab?node-id=1-2';
  const planning = annotationRemovePlanningArgvFromRequest({ nodeId: url, index: 0 });
  assert.equal(annotationRemoveFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['annotate', 'remove', '1:2', '0']);
});

test('Annotation Remove deletes one exact index and freshly verifies every sibling', async () => {
  const live = fixture();
  const result = await executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(live.annotations, [BEFORE[1]]);
  assert.equal(live.writes, 1);
  assert.equal(result.result.status, 'removed');
  assert.equal(result.result.remaining, 1);
  assert.deepEqual(result.result.removed, {
    label: 'Review', labelMarkdown: null, categoryId: 'C:1',
    properties: [{ type: 'width' }],
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    id: '1:2', name: 'Card', index: 0, removed: BEFORE[0],
  });
});

test('a thrown native acknowledgement succeeds only after exact fresh readback', async () => {
  const live = fixture({ writeMode: 'throw-after' });
  const result = await executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.deepEqual(live.annotations, [BEFORE[1]]);
});

test('a no-effect mutation reports unchanged without retry', async () => {
  const live = fixture({ writeMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'unchanged');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.deepEqual(live.annotations, BEFORE);
  assert.equal(live.writes, 1);
});

test('a partial postcondition restores the exact annotation snapshot once', async () => {
  const live = fixture({ writeMode: 'partial' });
  await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
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

test('failed rollback and unavailable verification remain explicit', async () => {
  const partial = fixture({ writeMode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
    evaluate: evaluate(partial.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });

  const unavailable = fixture({
    writeMode: 'partial', rollbackMode: 'no-effect', readFailures: [4],
  });
  await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
});

test('missing target, invalid facts, and out-of-range index refuse before mutation', async () => {
  for (const live of [
    fixture({ missing: true }),
    fixture({ initial: [{ properties: [{ type: 'future' }] }] }),
  ]) {
    await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
      evaluate: evaluate(live.figma),
    }), (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.writes, 0);
  }

  const range = fixture();
  await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 2 }, {
    evaluate: evaluate(range.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(range.writes, 0);
});

test('one authentic non-retrying remove Plan crosses CLI and MCP', async () => {
  const cli = planFigmaCommand(['annotate', 'remove', '1-2', '00'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'remove', '1:2', '0'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(annotationRemovePlanRoute(cli), 'command-application');
  const live = fixture();
  const result = await executeAnnotationRemovePlan(cli, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'removed');
  assert.equal(annotationRemovePlanRoute(
    planFigmaCommand(['annotate', 'clear', '1:2'], { adapter: 'mcp' }),
  ), 'not-annotation-remove');
});

test('malformed Plugin results cannot become successful removes', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'removed' })]) {
    await assert.rejects(() => executeAnnotationRemove({ nodeId: '1:2', index: 0 }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('Annotation Remove generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${annotationRemoveCode({ nodeId: '1:2', index: 0 })}`));
});
