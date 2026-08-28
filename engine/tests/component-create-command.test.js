import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentCreateArgvFromRequest,
  componentCreateCode,
  componentCreatePlanRoute,
  componentCreatePlanningArgvFromRequest,
  executeComponentCreate,
  executeComponentCreatePlan,
  formatComponentCreateResult,
} from '../src/application/component-create-command.js';
import { parseComponentCreateRequest } from '../src/application/component-create-request.js';

function fixture({ resizeNoEffect = false, removeNoEffect = false, throwCreate = false } = {}) {
  const registry = new Map();
  const first = { id: '3:1', type: 'RECTANGLE' };
  const second = { id: '3:2', type: 'TEXT' };
  const parent = {
    id: '2:2', type: 'FRAME', name: 'Destination', remote: false, parent: null,
    children: [first, second],
    appendChild(node) {
      if (node.parent?.children) {
        const oldIndex = node.parent.children.indexOf(node);
        if (oldIndex !== -1) node.parent.children.splice(oldIndex, 1);
      }
      this.children.push(node); node.parent = this;
    },
    insertChild(index, node) {
      if (node.parent?.children) {
        const oldIndex = node.parent.children.indexOf(node);
        if (oldIndex !== -1) node.parent.children.splice(oldIndex, 1);
      }
      this.children.splice(index, 0, node); node.parent = this;
    },
  };
  first.parent = parent; second.parent = parent;
  const page = {
    id: '1:1', type: 'PAGE', name: 'Test Page', remote: false, parent: null,
    children: [], appendChild: parent.appendChild, insertChild: parent.insertChild,
  };
  let creates = 0;
  const figma = {
    currentPage: page,
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    createComponent() {
      creates += 1;
      const component = {
        id: `9:${creates}`, type: 'COMPONENT', name: 'Component', remote: false,
        x: 0, y: 0, width: 100, height: 100, parent: null,
        resize(width, height) {
          if (!resizeNoEffect) { this.width = width; this.height = height; }
        },
        remove() {
          if (removeNoEffect) return;
          if (this.parent?.children) {
            const ownIndex = this.parent.children.indexOf(this);
            if (ownIndex !== -1) this.parent.children.splice(ownIndex, 1);
          }
          this.parent = null;
          registry.delete(this.id);
        },
      };
      registry.set(component.id, component);
      if (throwCreate) throw new Error('injected create failure');
      return component;
    },
  };
  registry.set(parent.id, parent);
  registry.set(page.id, page);
  return { figma, parent, page, registry, creates: () => creates };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  name: 'Created card', width: 240, height: 120, x: -16, y: 28,
  parentId: '2:2', index: 1, json: false, ...overrides,
});

test('Component Create request closes dimensions, positions, parent, index and output', () => {
  assert.deepEqual(parseComponentCreateRequest([
    'component', 'create', 'Created card', '-w240', '-h', '120',
    '-x=-16', '-y28', '--parent=2-2', '--index', '1', '--json',
  ]), request({ json: true }));
  assert.deepEqual(componentCreateArgvFromRequest(request()), [
    'component', 'create', '--width', '240', '--height', '120',
    '-x', '-16', '-y', '28', '--parent', '2:2', '--index', '1', 'Created card',
  ]);

  const parentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  assert.deepEqual(componentCreatePlanningArgvFromRequest(request({ parentId: parentUrl })), [
    'component', 'create', '--width', '240', '--height', '120',
    '-x', '-16', '-y', '28', '--parent', parentUrl, '--index', '1', 'Created card',
  ]);
  const plan = planFigmaCommand([
    'component', 'create', 'Created card', '-h', '120', '--parent', parentUrl,
  ], { adapter: 'mcp' });
  assert.equal(plan.id, 'component.create');
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv.includes('--height'), true);
  assert.equal(plan.argv.includes('120'), true);

  for (const argv of [
    ['component', 'create', 'One', 'Two'],
    ['component', 'create', '--width', '0'],
    ['component', 'create', '--height', '-2'],
    ['component', 'create', '--index', '-1'],
    ['component', 'create', '-x', 'nan'],
    ['component', 'create', '--parent', 'bad'],
    ['component', 'create', '--future'],
  ]) assert.throws(() => parseComponentCreateRequest(argv), /Invalid component create command/);
});

test('Component Create supports option-looking and empty names without losing values', () => {
  assert.deepEqual(componentCreateArgvFromRequest(request({ name: '--Card' })).slice(-2), ['--', '--Card']);
  assert.deepEqual(componentCreateArgvFromRequest(request({ name: '' })).slice(-2), ['--', '']);
  assert.equal(parseComponentCreateRequest(['component', 'create']).name, 'Component');
});

test('explicit parent creation verifies exact geometry, index and name', async () => {
  const live = fixture();
  const result = await executeComponentCreate(request({ json: true }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'created');
  assert.deepEqual(result.result.component, {
    id: '9:1', name: 'Created card', type: 'COMPONENT', remote: false,
    parentId: '2:2', index: 1, x: -16, y: 28, width: 240, height: 120,
  });
  assert.deepEqual(live.parent.children.map((node) => node.id), ['3:1', '9:1', '3:2']);
  assert.deepEqual(JSON.parse(result.stdout), result.result);
  assert.equal(live.creates(), 1);
});

test('default current-page creation and explicit page index remain available', async () => {
  const live = fixture();
  const first = { id: '4:1', type: 'FRAME', parent: live.page };
  live.page.children.push(first);
  live.registry.set(first.id, first);
  const result = await executeComponentCreate({
    name: 'Component', width: 100, height: 100, x: 0, y: 0,
    parentId: null, index: 0, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.component.parentId, '1:1');
  assert.equal(result.result.component.index, 0);
  assert.deepEqual(live.page.children.map((node) => node.id), ['9:1', '4:1']);
});

test('invalid parent and out-of-range index refuse before creation', async () => {
  const cases = [
    [fixture(), request({ parentId: '7:7' })],
    [fixture(), request({ index: 3 })],
  ];
  for (const [live, input] of cases) {
    await assert.rejects(() => executeComponentCreate(input, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.creates(), 0);
  }
});

test('failed postcondition removes the exact new Component and restores order', async () => {
  const live = fixture({ resizeNoEffect: true });
  await assert.rejects(() => executeComponentCreate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.deepEqual(live.parent.children.map((node) => node.id), ['3:1', '3:2']);
  assert.equal(live.registry.has('9:1'), false);
});

test('failed rollback reports exact Component residue', async () => {
  const live = fixture({ resizeNoEffect: true, removeNoEffect: true });
  await assert.rejects(() => executeComponentCreate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
  assert.deepEqual(live.parent.children.map((node) => node.id), ['3:1', '9:1', '3:2']);
});

test('create failure without an attributable id is verification-unavailable', async () => {
  const live = fixture({ throwCreate: true });
  await assert.rejects(() => executeComponentCreate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
});

test('generated Component Create code keeps hostile names inert', () => {
  const code = componentCreateCode(request({
    name: '`); globalThis.COMPONENT_CREATE_INJECTED = true; //',
  }));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.equal(globalThis.COMPONENT_CREATE_INJECTED, undefined);
});

test('one authentic non-retrying component.create Plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(componentCreateArgvFromRequest(request({ json: true })), {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'component.create');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(componentCreatePlanRoute(plan), 'command-application');
  assert.throws(() => componentCreatePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentCreatePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful Components', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeComponentCreate(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes control-bearing names', () => {
  const text = formatComponentCreateResult({ component: {
    id: '9:1', name: 'Component\u202e', type: 'COMPONENT', remote: false,
    parentId: '2:2', index: 0, x: 0, y: 0, width: 100, height: 100,
  } });
  assert.doesNotMatch(text, /\u202e/u);
  assert.match(text, /\\u202e/);
});
