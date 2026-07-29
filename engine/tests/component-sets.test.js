// Component-set surfacing (semantic regression): the screen shows one
// variant per instance, but the set axes (state=default/hover/…) define the
// interactive states the build must include. The walker collects them once
// per set; the spec lists them with an interactive marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode } from '../src/design-extract.js';
import { formatCodeSpec, specModel } from '../src/lib/code-spec.js';

const buttonSet = {
  id: 'set:1', name: 'button', type: 'COMPONENT_SET',
  variantGroupProperties: {
    type: { values: ['primary', 'secondary'] },
    state: { values: ['default', 'hover', 'active'] },
  },
};
const badgeSet = {
  id: 'set:2', name: 'badge', type: 'COMPONENT_SET',
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
  assert.deepEqual(button.props.state, ['default', 'hover', 'active']);
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
});
