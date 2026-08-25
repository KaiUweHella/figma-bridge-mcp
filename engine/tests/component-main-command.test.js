import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentMainCode,
  componentMainPlanRoute,
  componentMainPlanningArgvFromRequest,
  executeComponentMain,
  executeComponentMainPlan,
  MAX_COMPONENT_MAIN_CONTAINER_ENTRIES,
} from '../src/application/component-main-command.js';
import {
  acceptsComponentMainArgv,
  componentMainArgvFromRequest,
  parseComponentMainRequest,
} from '../src/application/component-main-request.js';

const PAYLOAD = {
  schemaVersion: 1,
  instance: { id: '10:3', name: 'Button instance' },
  role: 'INSTANCE',
  mainComponent: { id: '10:1', name: 'State=Default', key: 'BUTTON_KEY', remote: false },
  set: {
    id: '10:2', name: 'Button', key: 'BUTTON_SET_KEY',
    variants: [
      { id: '10:1', name: 'State=Default' },
      { id: '10:4', name: 'State=Active' },
    ],
  },
  variantProperties: { State: 'Default' },
  componentProperties: { Label: { type: 'TEXT', value: 'Continue' } },
  componentPropertyDefinitions: {
    State: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Active'] },
    Label: { type: 'TEXT', defaultValue: 'Button' },
  },
  variantGroupProperties: null,
};

test('Component Main request closes and canonicalizes the complete CLI surface', () => {
  assert.deepEqual(parseComponentMainRequest(['component', 'main', '--json', '10-3']), {
    instanceId: '10:3', json: true, warning: '',
  });
  assert.deepEqual(componentMainArgvFromRequest({ instanceId: '10-3', json: true }),
    ['component', 'main', '10:3', '--json']);
  for (const argv of [
    ['component', 'main'],
    ['component', 'main', '10:3', '10:4'],
    ['component', 'main', '--future', 'private-value'],
    ['component', 'main', '--json', '--json', '10:3'],
    ['component', 'main', 'not-a-node'],
  ]) assert.equal(acceptsComponentMainArgv(argv), false, argv.join(' '));
});

test('Component Main returns bounded identity facts in text and legacy JSON shapes', async () => {
  let code = '';
  const text = await executeComponentMain({ instanceId: '10:3' }, {
    evaluate: async (value) => { code = value; return JSON.stringify(PAYLOAD); },
  });
  assert.match(code, /getMainComponentAsync\(\)/);
  assert.match(code, /Component Main serialized-size limit exceeded/);
  assert.equal(text.stdout, [
    'Button instance (10:3)',
    '  main: State=Default (10:1, key BUTTON_KEY)',
    '  set:  Button (10:2, key BUTTON_SET_KEY, 2 variants)',
    '  variant values:',
    '    State = Default',
    '  property definitions:',
    '    State: VARIANT [Default | Active] (default: "Default")',
    '    Label: TEXT (default: "Button")',
  ].join('\n'));

  const json = await executeComponentMain({ instanceId: '10:3', json: true }, {
    evaluate: async () => JSON.stringify(PAYLOAD),
  });
  assert.equal(Object.hasOwn(JSON.parse(json.stdout), 'schemaVersion'), false);
  assert.deepEqual(JSON.parse(json.stdout).mainComponent, PAYLOAD.mainComponent);
  assert.equal(json.result.schemaVersion, 1);
});

test('Component Main rejects malformed and unbounded Plugin results', async () => {
  await assert.rejects(
    () => executeComponentMain({ instanceId: '10:3' }, { evaluate: async () => ({ ...PAYLOAD }) }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeComponentMain({ instanceId: '10:3' }, {
      evaluate: async () => JSON.stringify({
        ...PAYLOAD,
        set: { ...PAYLOAD.set, variants: PAYLOAD.set.variants.slice(1) },
      }),
    }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeComponentMain({ instanceId: '10:3' }, {
      evaluate: async () => JSON.stringify({
        ...PAYLOAD,
        componentProperties: { Label: { type: 'FUTURE', value: 'x' } },
      }),
    }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeComponentMain({ instanceId: '10:3' }, {
      evaluate: async () => JSON.stringify({ ...PAYLOAD, role: 'COMPONENT' }),
    }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeComponentMain({ instanceId: '10:3' }, {
      evaluate: async () => JSON.stringify({
        ...PAYLOAD,
        componentProperties: Object.fromEntries(Array.from(
          { length: MAX_COMPONENT_MAIN_CONTAINER_ENTRIES + 1 },
          (_, index) => [`Property ${index}`, { type: 'TEXT', value: 'x' }],
        )),
      }),
    }),
    /invalid bounded result/,
  );
});

test('Component Main Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand(['component', 'main', '10-3', '--json'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(componentMainPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['component', 'main', '10:3', '--json']);
  assert.deepEqual(
    (await executeComponentMainPlan(plan, { evaluate: async () => JSON.stringify(PAYLOAD) })).result,
    PAYLOAD,
  );
  await assert.rejects(
    () => executeComponentMainPlan({ ...plan }, { evaluate: async () => JSON.stringify(PAYLOAD) }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(componentMainPlanRoute(
    planFigmaCommand(['component', 'list'], { adapter: 'mcp' }),
  ), 'not-component-main');
});

test('Component Main planning keeps option-first URL target separate from canonical argv', () => {
  const url = 'https://www.figma.com/design/FILEA/Component-Lab?node-id=10-3';
  const planningArgv = componentMainPlanningArgvFromRequest({ instanceId: url, json: true });
  assert.equal(planningArgv[2], url);
  const typed = planFigmaCommand(planningArgv, { adapter: 'mcp' });
  const optionFirst = planFigmaCommand(['component', 'main', '--json', url], { adapter: 'mcp' });
  assert.equal(typed.target.fileKey, 'FILEA');
  assert.equal(optionFirst.target.fileKey, 'FILEA');
  assert.deepEqual(optionFirst.argv, ['component', 'main', '10:3', '--json']);
});

test('Component Main generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${componentMainCode({ instanceId: '10:3' })}`));
});
