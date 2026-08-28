import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentInstantiateArgvFromRequest,
  componentInstantiateCode,
  componentInstantiatePlanRoute,
  componentInstantiatePlanningArgvFromRequest,
  executeComponentInstantiate,
  executeComponentInstantiatePlan,
  formatComponentInstantiateResult,
} from '../src/application/component-instantiate-command.js';
import { parseComponentInstantiateRequest } from '../src/application/component-instantiate-request.js';

function fixture({
  remote = false,
  componentType = 'COMPONENT',
  recursiveParent = false,
  wrongMain = false,
  removeNoEffect = false,
  throwCreate = false,
} = {}) {
  const registry = new Map();
  const first = { id: '3:1', type: 'RECTANGLE' };
  const second = { id: '3:2', type: 'TEXT' };
  const parent = {
    id: '2:2', type: 'FRAME', name: 'Destination', remote: false,
    parent: null,
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
  let creates = 0;
  const component = {
    id: '2:1', type: componentType, name: 'Source component', remote,
    parent: null,
    createInstance() {
      creates += 1;
      const instance = {
        id: `9:${creates}`, type: 'INSTANCE', name: 'Source component',
        x: 0, y: 0, parent: null,
        getMainComponentAsync: async () => wrongMain ? { id: '8:8' } : component,
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
      registry.set(instance.id, instance);
      if (throwCreate) throw new Error('injected create failure');
      return instance;
    },
  };
  if (recursiveParent) parent.parent = component;
  const page = {
    id: '1:1', type: 'PAGE', name: 'Test Page', remote: false, parent: null,
    children: [],
    appendChild: parent.appendChild,
    insertChild: parent.insertChild,
  };
  registry.set(component.id, component);
  registry.set(parent.id, parent);
  registry.set(page.id, page);
  return {
    component, parent, page, registry,
    figma: {
      currentPage: page,
      getNodeByIdAsync: async (id) => registry.get(id) || null,
    },
    creates: () => creates,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  componentId: '2:1', parentId: '2:2', x: -12.5, y: 24, index: 1,
  name: 'Test instance', json: false, ...overrides,
});

test('Component Instantiate request closes options, signed positions and URL targets', () => {
  assert.deepEqual(parseComponentInstantiateRequest([
    'component', 'instantiate', '2-1', '-x=-12.5', '-y24', '--index=1',
    '--parent', '2-2', '--name=Test instance', '--json',
  ]), request({ json: true }));
  assert.deepEqual(componentInstantiateArgvFromRequest(request()), [
    'component', 'instantiate', '2:1', '-x', '-12.5', '-y', '24',
    '--name=Test instance', '--parent', '2:2', '--index', '1',
  ]);

  const componentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const parentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  assert.deepEqual(componentInstantiatePlanningArgvFromRequest(request({
    componentId: componentUrl, parentId: parentUrl,
  })), [
    'component', 'instantiate', componentUrl, '-x', '-12.5', '-y', '24',
    '--name=Test instance', '--parent', parentUrl, '--index', '1',
  ]);
  const plan = planFigmaCommand(componentInstantiatePlanningArgvFromRequest(request({
    componentId: componentUrl, parentId: parentUrl,
  })), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, componentInstantiateArgvFromRequest(request()));

  for (const argv of [
    ['component', 'instantiate'],
    ['component', 'instantiate', 'bad'],
    ['component', 'instantiate', '2:1', '3:1'],
    ['component', 'instantiate', '2:1', '--index', '-1'],
    ['component', 'instantiate', '2:1', '-x', 'nan'],
    ['component', 'instantiate', '2:1', '--future'],
    ['component', 'instantiate', componentUrl, '--parent',
      'https://www.figma.com/design/FILEB/Test?node-id=2-2'],
  ]) assert.throws(() => parseComponentInstantiateRequest(argv), /Invalid component instantiate command/);
});

test('exact Component instantiation preserves remote sources, placement, index and name', async () => {
  const live = fixture({ remote: true });
  const result = await executeComponentInstantiate(request({ json: true }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.component.remote, true);
  assert.deepEqual(result.result.instance, {
    id: '9:1', name: 'Test instance', type: 'INSTANCE', parentId: '2:2',
    index: 1, x: -12.5, y: 24, mainComponentId: '2:1',
  });
  assert.deepEqual(live.parent.children.map((node) => node.id), ['3:1', '9:1', '3:2']);
  assert.deepEqual(JSON.parse(result.stdout), result.result);
  assert.equal(live.creates(), 1);
});

test('default parent, position and append behavior remain available', async () => {
  const live = fixture();
  const result = await executeComponentInstantiate({
    componentId: '2:1', parentId: null, x: 0, y: 0,
    index: null, name: '', json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.instance.parentId, '1:1');
  assert.equal(result.result.instance.index, 0);
  assert.equal(result.result.instance.name, '');
  assert.deepEqual(live.page.children.map((node) => node.id), ['9:1']);
});

test('invalid source, recursive destination and out-of-range index refuse before creation', async () => {
  const cases = [
    [fixture({ componentType: 'FRAME' }), request()],
    [fixture({ recursiveParent: true }), request()],
    [fixture(), request({ index: 3 })],
  ];
  for (const [live, input] of cases) {
    await assert.rejects(() => executeComponentInstantiate(input, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.creates(), 0);
  }
});

test('failed postcondition removes only the newly created Instance and restores order', async () => {
  const live = fixture({ wrongMain: true });
  await assert.rejects(() => executeComponentInstantiate(request(), {
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

test('failed rollback reports exact Instance residue and never retries', async () => {
  const live = fixture({ wrongMain: true, removeNoEffect: true });
  await assert.rejects(() => executeComponentInstantiate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.attempted, 1);
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
  assert.deepEqual(live.parent.children.map((node) => node.id), ['3:1', '9:1', '3:2']);
});

test('create failure without an attributable returned id is verification-unavailable', async () => {
  const live = fixture({ throwCreate: true });
  await assert.rejects(() => executeComponentInstantiate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
});

test('generated code keeps names as inert data', () => {
  const name = '`); globalThis.COMPONENT_INSTANTIATE_INJECTED = true; //';
  const code = componentInstantiateCode(request({ name }));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.equal(globalThis.COMPONENT_INSTANTIATE_INJECTED, undefined);
});

test('one authentic non-retrying component.instantiate plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(componentInstantiateArgvFromRequest(request({ json: true })), {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'component.instantiate');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(componentInstantiatePlanRoute(plan), 'command-application');
  assert.throws(() => componentInstantiatePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentInstantiatePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful Instances', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeComponentInstantiate(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes control-bearing native names', () => {
  const text = formatComponentInstantiateResult({
    component: { id: '2:1', name: 'Source\u202e', remote: false },
    instance: {
      id: '9:1', name: 'Instance\u0000', type: 'INSTANCE', parentId: '2:2',
      index: 0, x: 0, y: 0, mainComponentId: '2:1',
    },
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
  assert.match(text, /\\u202e|\\u0000/);
});
