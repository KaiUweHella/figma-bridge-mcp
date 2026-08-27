import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentCombineCode,
  componentCombinePlanRoute,
  componentCombinePlanningArgvFromRequest,
  executeComponentCombine,
  executeComponentCombinePlan,
} from '../src/application/component-combine-command.js';
import {
  acceptsComponentCombineArgv,
  componentCombineArgvFromRequest,
  componentCombineFigmaUrlFileKeyFromArgv,
  parseComponentCombineRequest,
} from '../src/application/component-combine-request.js';

async function evaluateCode(code, figma) {
  return new Function('figma', `return ${code}`)(figma);
}

function fixture() {
  const page = {
    id: '0:1', name: 'Fixture page', type: 'PAGE', parent: null, children: [],
    appendChild(child) { child.parent = this; this.children.push(child); },
  };
  const components = [
    { id: '10:1', name: 'State=Default', type: 'COMPONENT', remote: false, parent: page },
    { id: '10:2', name: 'State=Hover', type: 'COMPONENT', remote: false, parent: page },
    { id: '10:3', name: 'State=Pressed', type: 'COMPONENT', remote: false, parent: page },
  ];
  page.children.push(...components);
  const byId = new Map(components.map((component) => [component.id, component]));
  let setId = 20;
  const figma = {
    currentPage: page,
    async getNodeByIdAsync(id) { return byId.get(id) || null; },
    combineAsVariants(nodes, parent) {
      const set = {
        id: `20:${setId++}`, name: '', type: 'COMPONENT_SET', parent, children: [...nodes],
      };
      for (const node of nodes) node.parent = set;
      parent.children = parent.children.filter((child) => !nodes.includes(child));
      parent.children.push(set);
      byId.set(set.id, set);
      return set;
    },
  };
  return { figma, page, components, byId };
}

test('Component Combine closes comma-separated and repeated id forms to one ordered request', () => {
  const comma = parseComponentCombineRequest([
    'component', 'combine', '10-1,10:2', '10:3', '--name', 'Button', '--json',
  ]);
  const repeated = parseComponentCombineRequest([
    'component', 'combine', '--json', '--name=Button', '10:1', '10:2', '10:3',
  ]);
  assert.deepEqual(comma, repeated);
  assert.deepEqual(comma, {
    componentIds: ['10:1', '10:2', '10:3'], name: 'Button', json: true,
  });
  assert.deepEqual(componentCombineArgvFromRequest(comma), [
    'component', 'combine', '10:1', '10:2', '10:3', '--name=Button', '--json',
  ]);

  for (const argv of [
    ['component', 'combine', '10:1'],
    ['component', 'combine', '10:1', '10:1'],
    ['component', 'combine', '10:1,', '10:2'],
    ['component', 'combine', '10:1', '--name'],
    ['component', 'combine', '10:1', '10:2', '--name', '--json'],
    ['component', 'combine', '10:1', '10:2', '--name=A', '--name=B'],
    ['component', 'combine', '10:1', '10:2', '--json', '--json'],
    ['component', 'combine', '10:1', '10:2', '--future'],
  ]) assert.equal(acceptsComponentCombineArgv(argv), false, argv.join(' '));
});

test('Component Combine derives one target from every URL-bearing component reference', () => {
  const first = 'https://www.figma.com/design/FILEA/Fixture?node-id=10-1';
  const second = 'https://www.figma.com/design/FILEA/Fixture?node-id=10-2';
  const planning = componentCombinePlanningArgvFromRequest({
    componentIds: [first, second], name: 'Button', json: true,
  });
  assert.equal(planning[2], first);
  assert.equal(planning[3], second);
  assert.equal(componentCombineFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  const cli = planFigmaCommand(planning, { adapter: 'cli' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, plan.argv);
  assert.deepEqual(plan.argv, [
    'component', 'combine', '10:1', '10:2', '--name=Button', '--json',
  ]);
  assert.throws(() => componentCombineFigmaUrlFileKeyFromArgv([
    'component', 'combine', first,
    'https://www.figma.com/design/FILEB/Fixture?node-id=10-2',
  ]), /multiple Figma files/);
});

test('Component Combine preflights every node and freshly verifies complete ordered membership', async () => {
  const { figma, page, components } = fixture();
  const execution = await executeComponentCombine({
    componentIds: components.map(({ id }) => id), name: 'Button', json: true,
  }, { evaluate: (code) => evaluateCode(code, figma) });

  assert.equal(execution.result.set.name, 'Button');
  assert.equal(execution.result.set.pageId, page.id);
  assert.deepEqual(execution.result.variants, [
    { id: '10:1', name: 'State=Default', inputIndex: 0 },
    { id: '10:2', name: 'State=Hover', inputIndex: 1 },
    { id: '10:3', name: 'State=Pressed', inputIndex: 2 },
  ]);
  assert.deepEqual(JSON.parse(execution.stdout), execution.result);
});

test('Component Combine rejects sets, remote components, cross-page inputs and incompatible ancestors before mutation', async () => {
  for (const mutate of [
    ({ components }) => { components[1].type = 'COMPONENT_SET'; },
    ({ components }) => { components[1].remote = true; },
    ({ components }) => {
      components[1].parent = { id: '0:2', name: 'Other', type: 'PAGE', parent: null, children: [components[1]] };
    },
    ({ components, page }) => {
      components[1].parent = { id: '30:1', name: 'Instance', type: 'INSTANCE', parent: page, children: [components[1]] };
    },
  ]) {
    const state = fixture();
    mutate(state);
    let mutations = 0;
    const original = state.figma.combineAsVariants;
    state.figma.combineAsVariants = (...args) => { mutations += 1; return original(...args); };
    await assert.rejects(
      () => executeComponentCombine({
        componentIds: state.components.map(({ id }) => id), name: 'Button',
      }, { evaluate: (code) => evaluateCode(code, state.figma) }),
      /add-variant|remote|same Figma page|cannot be reparented/,
    );
    assert.equal(mutations, 0);
  }
});

test('Component Combine fails closed on incomplete readback and only accepts authentic Plans', async () => {
  const state = fixture();
  const original = state.figma.combineAsVariants;
  state.figma.combineAsVariants = (...args) => {
    const set = original(...args);
    set.children.pop();
    return set;
  };
  await assert.rejects(
    () => executeComponentCombine({
      componentIds: state.components.map(({ id }) => id), name: 'Button',
    }, { evaluate: (code) => evaluateCode(code, state.figma) }),
    /complete requested membership/,
  );

  const plan = planFigmaCommand([
    'component', 'combine', '10:1,10:2', '--name', 'Button',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(componentCombinePlanRoute(plan), 'command-application');
  assert.equal(componentCombinePlanRoute(
    planFigmaCommand(['component', 'list'], { adapter: 'mcp' }),
  ), 'not-component-combine');
  assert.throws(() => componentCombinePlanRoute({ ...plan }), /requires a Command Plan/);
  const success = fixture();
  assert.equal((await executeComponentCombinePlan(plan, {
    evaluate: (code) => evaluateCode(code, success.figma),
  })).result.variants.length, 2);
});

test('Component Combine generated evaluation is injection-safe', () => {
  const code = componentCombineCode({
    componentIds: ['10:1', '10:2'], name: '"; globalThis.PWNED = true; //',
  });
  assert.doesNotThrow(() => new Function('figma', `return ${code}`));
  assert.doesNotMatch(code, /setName = "; globalThis/);
});
