import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationAddCode,
  annotationAddPlanRoute,
  annotationAddPlanningArgvFromRequest,
  executeAnnotationAdd,
  executeAnnotationAddPlan,
  MAX_ANNOTATION_ADD_TARGETS,
} from '../src/application/annotation-add-command.js';
import {
  acceptsAnnotationAddArgv,
  annotationAddArgvFromRequest,
  annotationAddFigmaUrlFileKeyFromArgv,
  parseAnnotationAddRequest,
} from '../src/application/annotation-add-request.js';

const INITIAL = Object.freeze([
  { label: '', labelMarkdown: '**Preserve both**', properties: [{ type: 'width' }] },
]);
const CATEGORIES = Object.freeze([
  { id: 'C:1', label: 'Review', color: 'blue', isPreset: false },
  { id: 'C:2', label: 'Review later', color: 'orange', isPreset: false },
]);

function clone(values) {
  return values.map((annotation) => ({
    ...annotation,
    ...(annotation.properties
      ? { properties: annotation.properties.map((property) => ({ ...property })) }
      : {}),
  }));
}

function runtime({
  count = 2,
  modes = {},
  rollbackModes = {},
  getFailures = [],
  categories = CATEGORIES,
} = {}) {
  let gets = 0;
  const states = new Map();
  const writes = new Map();
  const nodes = Array.from({ length: count }, (_, index) => {
    const id = `${index + 1}:1`;
    states.set(id, clone(INITIAL));
    writes.set(id, 0);
    return {
      id,
      name: `Card ${index + 1}`,
      type: 'FRAME',
      get annotations() { return clone(states.get(id)); },
      set annotations(value) {
        writes.set(id, writes.get(id) + 1);
        const rollback = JSON.stringify(value) === JSON.stringify(INITIAL);
        const mode = rollback ? rollbackModes[id] || 'normal' : modes[id] || 'normal';
        if (mode === 'no-effect') return;
        states.set(id, mode === 'partial'
          ? [...clone(value.slice(0, -1)), { label: 'Unexpected' }]
          : clone(value));
        if (mode === 'throw-after') throw new Error(`injected acknowledgement ${id}`);
      },
    };
  });
  return {
    nodes,
    annotations(id) { return clone(states.get(id)); },
    writes(id) { return writes.get(id); },
    figma: {
      currentPage: {
        findAll(predicate) { return nodes.filter((node) => predicate(node)); },
      },
      annotations: {
        async getAnnotationCategoriesAsync() {
          return categories.map((category) => ({ ...category }));
        },
      },
      async getNodeByIdAsync(id) {
        gets += 1;
        if (getFailures.includes(gets)) throw new Error('injected readback failure');
        return nodes.find((node) => node.id === id) || null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Annotation Add closes node/query grammar, payloads, and legacy node precedence', () => {
  assert.deepEqual(parseAnnotationAddRequest([
    'annotate', 'add', '--node=1-1', '--query=Card', '--markdown',
    '--category=Review', '--properties=width,itemSpacing', '--', '--help',
  ]), {
    selector: 'node', nodeId: '1:1', query: 'Card', text: '--help', markdown: true,
    category: 'Review', properties: ['width', 'itemSpacing'],
    warning: '--query was ignored because --node takes precedence',
  });
  assert.deepEqual(parseAnnotationAddRequest([
    'annotate', 'add', '--query=', '--category=', '--properties=', '--', '',
  ]), {
    selector: 'query', nodeId: null, query: '', text: '', markdown: false,
    category: null, properties: [], warning: '',
  });
  assert.deepEqual(annotationAddArgvFromRequest({
    nodeId: '1-1', text: '-note', markdown: false,
  }), ['annotate', 'add', '--node=1:1', '--', '-note']);

  for (const argv of [
    ['annotate', 'add', 'Note'],
    ['annotate', 'add', '--node=1:1'],
    ['annotate', 'add', '--node=1:1', '--node=1:2', 'Note'],
    ['annotate', 'add', '--query=Card', '--properties=future', 'Note'],
    ['annotate', 'add', '--query=Card', 'Note', 'extra'],
    ['annotate', 'add', '--node=not-a-node', 'Note'],
  ]) assert.equal(acceptsAnnotationAddArgv(argv), false, argv.join(' '));
});

test('Annotation Add derives target identity only from --node', () => {
  const nodeUrl = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  const payloadUrl = 'https://www.figma.com/design/FILEB/Payload?node-id=9-9';
  const planning = annotationAddPlanningArgvFromRequest({
    nodeId: nodeUrl, query: payloadUrl, text: payloadUrl, category: payloadUrl,
  });
  assert.equal(annotationAddFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv.some((token) => token.includes('FILEB')), true);
});

test('single-node Annotation Add preserves exact prior facts and legacy output', async () => {
  const live = runtime();
  const result = await executeAnnotationAdd({
    nodeId: '1:1', text: 'New', category: 'Review', properties: ['itemSpacing'],
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.annotations('1:1'), [
    INITIAL[0],
    { label: 'New', categoryId: 'C:1', properties: [{ type: 'itemSpacing' }] },
  ]);
  assert.equal(live.writes('1:1'), 1);
  assert.equal(result.stdout, '✓ Annotated Card 1 (1:1) at index 1');
  assert.deepEqual(result.result.categoryResolution, { requested: 'Review', resolvedId: 'C:1' });
});

test('query Annotation Add preflights and verifies every matching node', async () => {
  const live = runtime({ count: 3 });
  const result = await executeAnnotationAdd({ query: 'card', text: '**Ready**', markdown: true }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.targetCount, 3);
  assert.equal(result.result.applied, 3);
  assert.match(result.stdout, /^✓ Annotated 3 node\(s\):/);
  for (const node of live.nodes) {
    assert.deepEqual(live.annotations(node.id).at(-1), { labelMarkdown: '**Ready**' });
    assert.equal(live.writes(node.id), 1);
  }
});

test('thrown acknowledgements become bounded warnings only after exact readback', async () => {
  const live = runtime({ modes: { '1:1': 'throw-after', '2:1': 'throw-after' } });
  const result = await executeAnnotationAdd({ query: 'Card', text: 'New' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warningCount, 2);
  assert.equal(result.result.warnings.length, 2);
});

test('later query failure rolls back every earlier and current target in reverse journal order', async () => {
  const live = runtime({ modes: { '2:1': 'no-effect' } });
  await assert.rejects(() => executeAnnotationAdd({ query: 'Card', text: 'New' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 2, restored: 2, residueCount: 0,
    });
    return true;
  });
  assert.deepEqual(live.annotations('1:1'), INITIAL);
  assert.deepEqual(live.annotations('2:1'), INITIAL);
});

test('rollback residue and unavailable verification remain bounded and explicit', async () => {
  const partial = runtime({
    modes: { '2:1': 'partial' },
    rollbackModes: { '1:1': 'no-effect', '2:1': 'no-effect' },
  });
  await assert.rejects(() => executeAnnotationAdd({ query: 'Card', text: 'New' }, {
    evaluate: evaluate(partial.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });

  const unavailable = runtime({
    modes: { '2:1': 'partial' },
    rollbackModes: { '1:1': 'no-effect', '2:1': 'no-effect' },
    getFailures: [6],
  });
  await assert.rejects(() => executeAnnotationAdd({ query: 'Card', text: 'New' }, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.residueCount > 0);
});

test('ambiguous category, empty matches, and excessive query results refuse before mutation', async () => {
  const ambiguous = runtime();
  await assert.rejects(() => executeAnnotationAdd({
    query: 'Card', text: 'New', category: 'Rev',
  }, { evaluate: evaluate(ambiguous.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.match(error.message, /Ambiguous annotation category/);
    return true;
  });
  assert.equal(ambiguous.writes('1:1'), 0);

  const empty = runtime();
  await assert.rejects(() => executeAnnotationAdd({ query: 'Missing', text: 'New' }, {
    evaluate: evaluate(empty.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');

  const excessive = runtime({ count: MAX_ANNOTATION_ADD_TARGETS + 1 });
  await assert.rejects(() => executeAnnotationAdd({ query: 'Card', text: 'New' }, {
    evaluate: evaluate(excessive.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(excessive.nodes.every((node) => excessive.writes(node.id) === 0), true);
});

test('query Annotation Add rejects malformed target identity before mutation', async () => {
  const live = runtime({ count: 1 });
  live.nodes[0].id = 'not-a-node-id';
  await assert.rejects(() => executeAnnotationAdd({ query: 'Card', text: 'New' }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /exact annotation-capable nodes/.test(error.message));
  assert.equal(live.writes('1:1'), 0);
  assert.deepEqual(live.annotations('1:1'), INITIAL);
});

test('node and query plans share policy except for honest editor-context reads', async () => {
  const nodeCli = planFigmaCommand([
    'annotate', 'add', '--node=1-1', '--', 'New',
  ], { adapter: 'cli' });
  const nodeMcp = planFigmaCommand([
    'annotate', 'add', '--node=1:1', '--', 'New',
  ], { adapter: 'mcp' });
  assert.equal(nodeCli.allowed, true);
  assert.deepEqual(nodeCli.argv, nodeMcp.argv);
  assert.deepEqual(nodeCli.effects, nodeMcp.effects);
  assert.deepEqual(nodeCli.execution, nodeMcp.execution);
  assert.equal(nodeCli.effects.figma, 'write');
  assert.equal(nodeCli.effects.editor, 'none');
  assert.equal(nodeCli.execution.retry, 'never');
  assert.equal(annotationAddPlanRoute(nodeCli), 'command-application');
  const live = runtime();
  assert.equal((await executeAnnotationAddPlan(nodeCli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'annotated');

  const query = planFigmaCommand([
    'annotate', 'add', '--query=Card', '--', 'New',
  ], { adapter: 'mcp' });
  assert.equal(query.effects.editor, 'read');
  assert.equal(annotationAddPlanRoute(
    planFigmaCommand(['annotate', 'list', '1:1'], { adapter: 'mcp' }),
  ), 'not-annotation-add');
});

test('malformed Plugin results cannot become successful Annotation Adds', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'annotated' })]) {
    await assert.rejects(() => executeAnnotationAdd({ nodeId: '1:1', text: 'New' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('Annotation Add generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${annotationAddCode({ nodeId: '1:1', text: 'New' })}`));
  assert.doesNotThrow(() => new Function(
    `return ${annotationAddCode({ query: 'Card', text: 'New' })}`));
});
