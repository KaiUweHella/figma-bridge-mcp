import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationCategoryMutationCode,
  annotationCategoryMutationPlanRoute,
  executeAnnotationCategoryMutation,
  executeAnnotationCategoryMutationPlan,
} from '../src/application/annotation-category-mutation-command.js';
import {
  acceptsAnnotationCategoryMutationArgv,
  annotationCategoryMutationArgvFromRequest,
  parseAnnotationCategoryMutationRequest,
} from '../src/application/annotation-category-mutation-request.js';

const INITIAL = Object.freeze([
  { id: 'C:1', label: 'Review', color: 'blue', isPreset: false },
  { id: 'C:2', label: 'Review later', color: 'orange', isPreset: false },
  { id: 'P:1', label: 'Dev status', color: 'green', isPreset: true },
]);

function fixture({ mode = 'normal', rollbackMode = 'normal', readFailures = [] } = {}) {
  let stored = INITIAL.map((category) => ({ ...category }));
  let writes = 0;
  let inventoryReads = 0;
  let nextId = 3;
  const find = (id) => stored.find((category) => category.id === id) || null;
  const native = (id) => {
    const current = find(id);
    if (!current) return null;
    return {
      get id() { return current.id; },
      get label() { return current.label; },
      get color() { return current.color; },
      get isPreset() { return current.isPreset; },
      setLabel(value) {
        writes += 1;
        const rollback = value === INITIAL.find((category) => category.id === id)?.label;
        if (rollback && rollbackMode === 'no-effect') return;
        if (!rollback && mode === 'no-effect') return;
        current.label = !rollback && mode === 'partial' ? 'Unexpected' : value;
        if (!rollback && mode === 'throw-after') throw new Error('injected edit acknowledgement');
      },
      setColor(value) {
        writes += 1;
        const rollback = value === INITIAL.find((category) => category.id === id)?.color;
        if (rollback && rollbackMode === 'no-effect') return;
        if (!rollback && mode === 'no-effect') return;
        current.color = !rollback && mode === 'partial' ? 'red' : value;
        if (!rollback && mode === 'throw-after') throw new Error('injected edit acknowledgement');
      },
      remove() {
        writes += 1;
        const rollback = id.startsWith('C:new');
        if (rollback && rollbackMode === 'no-effect') return;
        if (!rollback && mode === 'no-effect') return;
        stored = stored.filter((category) => category.id !== id);
        if (!rollback && mode === 'partial' && stored[0]) stored[0].color = 'red';
        if (!rollback && mode === 'throw-after') throw new Error('injected remove acknowledgement');
      },
    };
  };
  return {
    get categories() { return stored.map((category) => ({ ...category })); },
    get writes() { return writes; },
    figma: {
      annotations: {
        async getAnnotationCategoriesAsync() {
          inventoryReads += 1;
          if (readFailures.includes(inventoryReads)) throw new Error('injected inventory failure');
          return stored.map((category) => native(category.id));
        },
        async getAnnotationCategoryByIdAsync(id) { return native(id); },
        async addAnnotationCategoryAsync(input) {
          writes += 1;
          if (mode === 'no-effect') throw new Error('injected add failure');
          const category = {
            id: `C:new${nextId++}`,
            label: mode === 'partial' ? 'Unexpected' : input.label,
            color: mode === 'partial' ? 'red' : input.color,
            isPreset: false,
          };
          stored.push(category);
          if (mode === 'throw-after') throw new Error('injected add acknowledgement');
          return native(category.id);
        },
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Annotation Category Mutation closes and canonicalizes all three grammars', () => {
  assert.deepEqual(parseAnnotationCategoryMutationRequest([
    'annotate', 'category-add', 'Ready', '--color', 'GREEN',
  ]), { action: 'add', category: null, label: 'Ready', color: 'green' });
  assert.deepEqual(parseAnnotationCategoryMutationRequest([
    'annotate', 'category-edit', '--label=', '--color=RED', '--', '-review',
  ]), { action: 'edit', category: '-review', label: '', color: 'red' });
  assert.deepEqual(parseAnnotationCategoryMutationRequest([
    'annotate', 'category-remove', 'Review',
  ]), { action: 'remove', category: 'Review', label: undefined, color: undefined });
  assert.deepEqual(annotationCategoryMutationArgvFromRequest({
    action: 'add', label: '', color: 'blue',
  }), ['annotate', 'category-add', '--color=blue', '--', '']);

  for (const argv of [
    ['annotate', 'category-add', 'Ready'],
    ['annotate', 'category-add', 'Ready', '--color=purple'],
    ['annotate', 'category-add', 'Ready', '--color=blue', '--label=x'],
    ['annotate', 'category-edit', 'Review'],
    ['annotate', 'category-edit', 'Review', '--label=x', '--label=y'],
    ['annotate', 'category-remove', 'Review', '--color=blue'],
    ['annotate', 'category-remove', 'Review', 'extra'],
  ]) assert.equal(acceptsAnnotationCategoryMutationArgv(argv), false, argv.join(' '));
});

test('Category Add verifies one new exact identity and legacy output', async () => {
  const live = fixture();
  const result = await executeAnnotationCategoryMutation({
    action: 'add', label: 'Ready', color: 'green',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(live.writes, 1);
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.count, 4);
  assert.deepEqual(JSON.parse(result.stdout), result.result.category);
  assert.deepEqual(result.result.category, {
    id: 'C:new3', label: 'Ready', color: 'green', isPreset: false,
  });
});

test('Category Add accepts thrown acknowledgement only after exact inventory diff', async () => {
  const live = fixture({ mode: 'throw-after' });
  const result = await executeAnnotationCategoryMutation({
    action: 'add', label: 'Ready', color: 'green',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.categories.length, 4);
});

test('Category Add rolls back only its identified malformed creation', async () => {
  const restored = fixture({ mode: 'partial' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'add', label: 'Ready', color: 'green',
  }, { evaluate: evaluate(restored.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.restored, 1);
    return true;
  });
  assert.deepEqual(restored.categories, INITIAL);

  const residue = fixture({ mode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'add', label: 'Ready', color: 'green',
  }, { evaluate: evaluate(residue.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.equal(residue.categories.length, 4);
});

test('Category Edit resolves exact labels, verifies full inventory, and supports no-op', async () => {
  const live = fixture();
  const result = await executeAnnotationCategoryMutation({
    action: 'edit', category: 'Review', label: 'Ready', color: 'teal',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'edited');
  assert.deepEqual(result.result.resolution, { requested: 'Review', id: 'C:1' });
  assert.equal(live.categories[0].label, 'Ready');
  assert.equal(live.categories[0].color, 'teal');

  const noOp = fixture();
  const same = await executeAnnotationCategoryMutation({
    action: 'edit', category: 'C:1', label: 'Review',
  }, { evaluate: evaluate(noOp.figma) });
  assert.equal(same.result.attempted, 0);
  assert.equal(noOp.writes, 0);
});

test('Category Edit keeps ambiguity visible and refuses presets before mutation', async () => {
  for (const request of [
    { action: 'edit', category: 'Rev', label: 'Ready' },
    { action: 'edit', category: 'P:1', label: 'Ready' },
  ]) {
    const live = fixture();
    await assert.rejects(() => executeAnnotationCategoryMutation(request, {
      evaluate: evaluate(live.figma),
    }), (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.writes, 0);
  }
});

test('Category Edit distinguishes unchanged, rollback, and residue', async () => {
  const unchanged = fixture({ mode: 'no-effect' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'edit', category: 'C:1', label: 'Ready',
  }, { evaluate: evaluate(unchanged.figma) }),
  (error) => error.mutationOutcome === 'unchanged');

  const restored = fixture({ mode: 'partial' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'edit', category: 'C:1', label: 'Ready',
  }, { evaluate: evaluate(restored.figma) }),
  (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(restored.categories, INITIAL);

  const residue = fixture({ mode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'edit', category: 'C:1', label: 'Ready',
  }, { evaluate: evaluate(residue.figma) }),
  (error) => error.mutationOutcome === 'partial-residue');
});

test('Category Remove is freshly verified but never identity-recreated', async () => {
  const live = fixture({ mode: 'throw-after' });
  const result = await executeAnnotationCategoryMutation({
    action: 'remove', category: 'Review',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'removed');
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(live.categories.some((category) => category.id === 'C:1'), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 'C:1', label: 'Review', color: 'blue',
  });

  const unchanged = fixture({ mode: 'no-effect' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'remove', category: 'C:1',
  }, { evaluate: evaluate(unchanged.figma) }),
  (error) => error.mutationOutcome === 'unchanged' && error.mutationReport.restored === 0);

  const residue = fixture({ mode: 'partial' });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'remove', category: 'C:1',
  }, { evaluate: evaluate(residue.figma) }),
  (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.restored === 0);

  const unavailable = fixture({ readFailures: [2] });
  await assert.rejects(() => executeAnnotationCategoryMutation({
    action: 'remove', category: 'C:1',
  }, { evaluate: evaluate(unavailable.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable');
});

test('one non-retrying Application owns policy-identical CLI and MCP plans', async () => {
  for (const request of [
    { action: 'add', label: 'Ready', color: 'green' },
    { action: 'edit', category: 'Review', label: 'Ready' },
    { action: 'remove', category: 'Review' },
  ]) {
    const argv = annotationCategoryMutationArgvFromRequest(request);
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(annotationCategoryMutationPlanRoute(cli), 'command-application');
    const result = await executeAnnotationCategoryMutationPlan(cli, {
      evaluate: evaluate(fixture().figma),
    });
    assert.equal(result.result.action, request.action);
  }
  assert.equal(annotationCategoryMutationPlanRoute(
    planFigmaCommand(['annotate', 'categories'], { adapter: 'mcp' }),
  ), 'not-annotation-category-mutation');
});

test('malformed Plugin results cannot become successful Category mutations', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeAnnotationCategoryMutation({
      action: 'add', label: 'Ready', color: 'green',
    }, { evaluate: async () => value }), /invalid/i);
  }
});

test('Annotation Category Mutation generated Plugin code parses', () => {
  for (const request of [
    { action: 'add', label: 'Ready', color: 'green' },
    { action: 'edit', category: 'Review', label: 'Ready' },
    { action: 'remove', category: 'Review' },
  ]) assert.doesNotThrow(() => new Function(`return ${annotationCategoryMutationCode(request)}`));
});
