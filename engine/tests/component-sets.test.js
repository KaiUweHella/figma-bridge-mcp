// Component-set surfacing (semantic regression): the screen shows one
// variant per instance, but the set axes (state=default/hover/…) define the
// interactive states the build must include. The walker collects them once
// per set; the spec lists them with an interactive marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode } from '../src/design-extract.js';
import { componentStateCoverage, formatCodeSpec, specModel } from '../src/lib/code-spec.js';

const entityData = (id) => (key) => key === 'figma-bridge-design-entity'
  ? JSON.stringify({ version: 1, id, kind: 'component' })
  : '';

const buttonSet = {
  id: 'set:1', key: 'BUTTON_SET_KEY', name: 'button', type: 'COMPONENT_SET',
  getPluginData: entityData('component.button'),
  variantGroupProperties: {
    type: { values: ['primary', 'secondary'] },
    state: { values: ['default', 'hover', 'active'] },
  },
};
const badgeSet = {
  id: 'set:2', key: 'BADGE_SET_KEY', name: 'badge', type: 'COMPONENT_SET',
  getPluginData: entityData('component.badge'),
  variantGroupProperties: { tone: { values: ['info', 'attention'] } },
};

const makeTree = () => {
  const root = {
    id: 'r:1', name: 'screen', type: 'FRAME', visible: true, width: 400, height: 200,
    layoutMode: 'VERTICAL', children: [],
  };
  const inst = (id, set, mainName) => ({
    id, name: mainName, type: 'INSTANCE', visible: true, width: 100, height: 40,
    children: [], parent: root,
    getMainComponentAsync: async () => ({ name: mainName, parent: set }),
    componentProperties: {},
  });
  root.children = [
    inst('i:1', buttonSet, 'type=primary, state=default'),
    inst('i:2', buttonSet, 'type=secondary, state=default'), // same set — collected once
    inst('i:3', badgeSet, 'tone=info'),
  ];
  return root;
};

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (root, opts) =>
  new Function('figma', `return ${nodeWalkerCode(root.id, opts)}`)(stubFigma(root));

test('walker: sets envelope — one entry per set with axes/values', async () => {
  const result = JSON.parse(await runWalker(makeTree(), { resolveInstances: true }));
  assert.equal(result.sets.length, 2, 'button collected once despite two instances');
  const button = result.sets.find((s) => s.name === 'button');
  assert.equal(button.id, 'set:1');
  assert.equal(button.entityId, 'component.button');
  assert.equal(button.setKey, 'BUTTON_SET_KEY');
  assert.deepEqual(button.props.state, ['default', 'hover', 'active']);
});

test('walker keys sets by Design Entity/publish identity rather than display name', async () => {
  const root = makeTree();
  const secondButtonSet = {
    ...buttonSet,
    id: 'set:9', key: 'SECOND_BUTTON_SET_KEY',
    getPluginData: entityData('component.secondary-button'),
  };
  root.children.push({
    id: 'i:9', name: 'type=primary, state=default', type: 'INSTANCE', visible: true,
    width: 100, height: 40, children: [], parent: root, componentProperties: {},
    getMainComponentAsync: async () => ({
      name: 'type=primary, state=default', parent: secondButtonSet,
    }),
  });
  const result = JSON.parse(await runWalker(root, { resolveInstances: true }));
  assert.equal(result.sets.filter((set) => set.name === 'button').length, 2);
  assert.deepEqual(
    result.sets.filter((set) => set.name === 'button').map((set) => set.entityId).sort(),
    ['component.button', 'component.secondary-button'],
  );
});

test('component-state coverage distinguishes defined, noneDefined, and notCaptured', () => {
  const coverage = componentStateCoverage({
    sets: [
      {
        name: 'button', id: 'set:1', entityId: 'component.button',
        props: { Type: ['primary'], State: ['default', 'hover'] },
      },
      {
        name: 'badge', id: 'set:2', setKey: 'BADGE_SET_KEY',
        props: { Tone: ['info', 'attention'] },
      },
      {
        name: 'switch', id: 'set:3', setKey: 'SWITCH_SET_KEY', props: { Size: ['sm', 'lg'] },
        componentPropertyDefinitions: {
          'Show icon#bool:1': { type: 'BOOLEAN', defaultValue: true },
        },
      },
      { name: 'unresolved', id: 'set:4', setKey: 'MISSING_SET_KEY', props: null },
    ],
  });

  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.notCapturedIds, ['set:4']);
  const [button, badge, toggle, unresolved] = coverage.sets;
  assert.equal(button.status, 'defined');
  assert.deepEqual(button.identity, { kind: 'designEntity', value: 'component.button' });
  assert.deepEqual(button.axes, [{ source: 'State', canonical: 'state', values: ['default', 'hover'] }]);
  assert.equal(badge.status, 'noneDefined');
  assert.deepEqual(badge.identity, { kind: 'setKey', value: 'BADGE_SET_KEY' });
  assert.equal(toggle.status, 'defined');
  assert.deepEqual(toggle.booleans, [{
    source: 'Show icon', canonical: 'boolean:show-icon', values: [false, true], defaultValue: true,
  }]);
  assert.equal(unresolved.status, 'notCaptured');
});

test('walker without resolveInstances: sets stay empty (no instance descent)', async () => {
  const result = JSON.parse(await runWalker(makeTree(), { resolveInstances: false }));
  assert.deepEqual(result.sets, []);
});

test('spec renders the set section; interactive axes flagged with the state note', async () => {
  const result = JSON.parse(await runWalker(makeTree(), { resolveInstances: true }));
  const text = formatCodeSpec(result, { phase: 'all' });
  assert.match(text, /## Component sets used on this screen/);
  assert.match(text, /- button — type: primary\/secondary · state: default\/hover\/active ⚑ · \[set:1\]/);
  assert.match(text, /- badge — tone: info\/attention · \[set:2\]/);
  assert.match(text, /INTERACTIVE STATES/, 'hover note present because a ⚑ axis exists');
  // no interactive axes → no note, but section still lists the sets
  const calm = formatCodeSpec({ id: 'r', name: 'X', frames: [], sets: [{ name: 'badge', id: 's:9', props: { tone: ['info', 'attention'] } }] }, { phase: 'all' });
  assert.match(calm, /## Component sets used on this screen/);
  assert.doesNotMatch(calm, /INTERACTIVE STATES/);
  // and no section at all without sets
  const none = formatCodeSpec({ id: 'r', name: 'X', frames: [] }, { phase: 'all' });
  assert.doesNotMatch(none, /Component sets used/);
});

test('yaml/json model carries the sets', async () => {
  const result = JSON.parse(await runWalker(makeTree(), { resolveInstances: true }));
  const model = specModel(result, { phase: 'all' });
  assert.equal(model.sets.length, 2);
  assert.equal(model.sets[0].name, 'button');
  assert.equal(model.checks.componentStates.complete, true);
  assert.deepEqual(model.checks.componentStates.sets.map((set) => set.status), ['defined', 'noneDefined']);
});
