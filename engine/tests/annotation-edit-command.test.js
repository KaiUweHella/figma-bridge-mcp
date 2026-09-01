import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationEditCode,
  annotationEditPlanRoute,
  annotationEditPlanningArgvFromRequest,
  executeAnnotationEdit,
  executeAnnotationEditPlan,
} from '../src/application/annotation-edit-command.js';
import {
  acceptsAnnotationEditArgv,
  annotationEditArgvFromRequest,
  annotationEditFigmaUrlFileKeyFromArgv,
  parseAnnotationEditRequest,
} from '../src/application/annotation-edit-request.js';

const BEFORE = Object.freeze([
  { label: 'Old', categoryId: 'C:1', properties: [{ type: 'width' }] },
  { labelMarkdown: '**Second**' },
]);
const CATEGORIES = Object.freeze([
  { id: 'C:1', label: 'Review' },
  { id: 'C:2', label: 'Review later' },
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
  categories = CATEGORIES,
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
      const rollback = value[0]?.label === initial[0]?.label;
      if (rollback && rollbackMode === 'no-effect') return;
      if (rollback && rollbackMode === 'throw-before') throw new Error('injected rollback failure');
      if (!rollback && writeMode === 'no-effect') return;
      if (!rollback && writeMode === 'throw-before') throw new Error('injected edit failure');
      stored = !rollback && writeMode === 'partial'
        ? [{ label: 'Unexpected' }, ...clone(value.slice(1))]
        : clone(value);
      if (!rollback && writeMode === 'throw-after') throw new Error('injected acknowledgement failure');
    },
  };
  return {
    node,
    get annotations() { return clone(stored); },
    get writes() { return writes; },
    figma: {
      annotations: {
        async getAnnotationCategoryByIdAsync(id) {
          return categories.find((category) => category.id === id) || null;
        },
        async getAnnotationCategoriesAsync() { return categories.map((category) => ({ ...category })); },
      },
      async getNodeByIdAsync(nodeId) {
        reads += 1;
        if (readFailures.includes(reads)) throw new Error('injected readback failure');
        return nodeId === node.id && !missing ? node : null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Annotation Edit closes the complete legacy patch grammar and canonicalizes it', () => {
  assert.deepEqual(parseAnnotationEditRequest([
    'annotate', 'edit', '1-2', '01', '-t', 'New', '-m', '-cReview', '-pwidth,itemSpacing',
  ]), {
    nodeId: '1:2', index: 1, text: 'New', markdown: true,
    category: 'Review', properties: ['width', 'itemSpacing'],
  });
  assert.deepEqual(annotationEditArgvFromRequest({
    nodeId: '1-2', index: '1e0', text: '', markdown: true, category: '', properties: '',
  }), [
    'annotate', 'edit', '1:2', '1', '--text=', '--markdown', '--category=', '--properties=',
  ]);
  assert.deepEqual(parseAnnotationEditRequest([
    'annotate', 'edit', '--category=', '--properties=', '1:2', '0',
  ]).properties, []);

  for (const argv of [
    ['annotate', 'edit', '1:2', '0'],
    ['annotate', 'edit', '1:2', '-1', '--text=x'],
    ['annotate', 'edit', '1:2', '0', '--text=x', '--text=y'],
    ['annotate', 'edit', '1:2', '0', '--properties=future'],
    ['annotate', 'edit', '1:2', '0', '--text=x', 'extra'],
    ['annotate', 'edit', 'not-a-node', '0', '--text=x'],
  ]) assert.equal(acceptsAnnotationEditArgv(argv), false, argv.join(' '));
});

test('Annotation Edit derives target identity only from the typed node', () => {
  const url = 'https://www.figma.com/design/FILEA/Annotation-Lab?node-id=1-2';
  const payloadUrl = 'https://www.figma.com/design/FILEB/Payload?node-id=9-9';
  const planning = annotationEditPlanningArgvFromRequest({
    nodeId: url, index: 0, text: payloadUrl,
  });
  assert.equal(annotationEditFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv[2], '1:2');
  assert.ok(plan.argv.includes(`--text=${payloadUrl}`));
});

test('Annotation Edit applies markdown, exact category resolution, and property clearing once', async () => {
  const live = fixture();
  const result = await executeAnnotationEdit({
    nodeId: '1:2', index: 0, text: '**New**', markdown: true,
    category: 'Review', properties: [],
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.annotations, [
    { labelMarkdown: '**New**', categoryId: 'C:1', properties: [] },
    BEFORE[1],
  ]);
  assert.equal(live.writes, 1);
  assert.equal(result.result.status, 'edited');
  assert.deepEqual(result.result.categoryResolution, { requested: 'Review', resolvedId: 'C:1' });
  assert.deepEqual(JSON.parse(result.stdout), {
    id: '1:2', name: 'Card', index: 0,
    annotation: { labelMarkdown: '**New**', categoryId: 'C:1', properties: [] },
  });
});

test('category and property clear patches preserve untouched label facts', async () => {
  const live = fixture();
  const result = await executeAnnotationEdit({
    nodeId: '1:2', index: 0, category: '', properties: [], markdown: true,
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.annotations[0], { label: 'Old', properties: [] });
  assert.deepEqual(result.result.categoryResolution, { requested: '', resolvedId: null });
});

test('an already matching patch is a verified no-op', async () => {
  const live = fixture();
  const result = await executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'Old' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.attempted, 0);
  assert.equal(live.writes, 0);
});

test('a thrown native acknowledgement succeeds only after exact fresh readback', async () => {
  const live = fixture({ writeMode: 'throw-after' });
  const result = await executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'New' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.annotations[0].label, 'New');
});

test('no-effect, rollback, residue, and unavailable verification remain distinct', async () => {
  const unchanged = fixture({ writeMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'New' }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged');
  assert.equal(unchanged.writes, 1);

  const rolledBack = fixture({ writeMode: 'partial' });
  await assert.rejects(() => executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'New' }, {
    evaluate: evaluate(rolledBack.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored === 1);
  assert.deepEqual(rolledBack.annotations, BEFORE);

  const partial = fixture({ writeMode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'New' }, {
    evaluate: evaluate(partial.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);

  const unavailable = fixture({
    writeMode: 'partial', rollbackMode: 'no-effect', readFailures: [4],
  });
  await assert.rejects(() => executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'New' }, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('ambiguous category, invalid target facts, and out-of-range index refuse before mutation', async () => {
  const ambiguous = fixture();
  await assert.rejects(() => executeAnnotationEdit({
    nodeId: '1:2', index: 0, category: 'Rev',
  }, { evaluate: evaluate(ambiguous.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.match(error.message, /Ambiguous annotation category/);
    return true;
  });
  assert.equal(ambiguous.writes, 0);

  for (const [live, request] of [
    [fixture({ missing: true }), { nodeId: '1:2', index: 0, text: 'New' }],
    [fixture({ initial: [{ properties: [{ type: 'future' }] }] }),
      { nodeId: '1:2', index: 0, text: 'New' }],
    [fixture(), { nodeId: '1:2', index: 2, text: 'New' }],
  ]) {
    await assert.rejects(() => executeAnnotationEdit(request, {
      evaluate: evaluate(live.figma),
    }), (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.writes, 0);
  }
});

test('one authentic non-retrying edit Plan crosses CLI and MCP', async () => {
  const cli = planFigmaCommand([
    'annotate', 'edit', '1-2', '00', '--text=New', '--properties=width',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'annotate', 'edit', '--properties=width', '--text=New', '1:2', '0',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(annotationEditPlanRoute(cli), 'command-application');
  const live = fixture();
  const result = await executeAnnotationEditPlan(cli, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'edited');
  assert.equal(annotationEditPlanRoute(
    planFigmaCommand(['annotate', 'remove', '1:2', '0'], { adapter: 'mcp' }),
  ), 'not-annotation-edit');
});

test('malformed Plugin results cannot become successful edits', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'edited' })]) {
    await assert.rejects(() => executeAnnotationEdit({ nodeId: '1:2', index: 0, text: 'New' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('Annotation Edit generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${annotationEditCode({ nodeId: '1:2', index: 0, text: 'New' })}`));
});
