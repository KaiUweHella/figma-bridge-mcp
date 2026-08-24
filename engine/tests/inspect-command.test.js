import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeInspect,
  executeInspectPlan,
  formatInspection,
  inspectNodeCode,
  inspectPlanRoute,
  inspectPlanningArgvFromRequest,
} from '../src/application/inspect-command.js';
import {
  acceptsInspectArgv,
  inspectArgvFromRequest,
  parseInspectRequest,
} from '../src/application/inspect-request.js';

const RESULT = {
  id: '1:2', name: 'Card', type: 'FRAME', width: 320, height: 180,
  absolutePositioning: {
    position: 'ABSOLUTE', start: 16, end: null, top: 24, bottom: null,
    centerHorizontalOffset: null, centerVerticalOffset: null,
    width: 320, height: 180, layoutSizingHorizontal: null, layoutSizingVertical: null,
  },
  style: { fills: ['#ffffff'], cornerRadius: 16, clipsContent: true },
  raw: { x: 16, y: 24, constraints: { horizontal: 'MIN', vertical: 'MIN' } },
};

test('inspect Command Application returns values through one evaluate adapter', async () => {
  let code = '';
  const result = await executeInspect({ nodeId: '1-2', format: 'yaml' }, {
    evaluate: async (value) => { code = value; return RESULT; },
  });
  assert.match(code, /getNodeByIdAsync\("1:2"\)/);
  assert.match(result.stdout, /name: Card/);
  assert.match(result.stdout, /cornerRadius: 16/);
  assert.equal(result.result, RESULT);
});

test('inspect formats share one captured result without losing facts', () => {
  const json = JSON.parse(formatInspection(RESULT, 'json'));
  assert.deepEqual(json, RESULT);
  assert.deepEqual(JSON.parse(formatInspection(RESULT, 'spec')), RESULT.absolutePositioning);
  assert.match(formatInspection(RESULT, 'text'), /Absolute Positioning spec/);
  assert.match(formatInspection(RESULT, 'yaml'), /clipsContent: true/);
});

test('inspect validates before evaluating and generated plugin code parses', async () => {
  await assert.rejects(() => executeInspect({ nodeId: '', format: 'yaml' }, { evaluate: async () => RESULT }), /non-empty nodeId/);
  await assert.rejects(() => executeInspect({ nodeId: '1:2', format: 'toml' }, { evaluate: async () => RESULT }), /Unknown inspect format/);
  assert.doesNotThrow(() => new Function(`return ${inspectNodeCode('1:2')};`));
});

test('inspect closes and canonicalizes its complete legacy option surface', () => {
  assert.deepEqual(parseInspectRequest(['inspect', '1-2', '--json']), {
    nodeId: '1:2', format: 'json', warning: '',
  });
  assert.deepEqual(parseInspectRequest(['inspect', '1:2', '--spec', '--format', 'yaml']), {
    nodeId: '1:2', format: 'yaml', warning: '',
  });
  assert.deepEqual(inspectArgvFromRequest({ nodeId: '1-2', format: 'spec' }),
    ['inspect', '1:2', '--format', 'spec']);
  assert.equal(acceptsInspectArgv(['inspect', '1:2', '-f=json']), true);
  for (const argv of [
    ['inspect'],
    ['inspect', '1:2', '3:4'],
    ['inspect', '1:2', '--future'],
    ['inspect', '1:2', '--format'],
    ['inspect', 'not-a-node'],
  ]) assert.equal(acceptsInspectArgv(argv), false, argv.join(' '));
});

test('inspect Plan route accepts only its authentic policy-owned Plan', async () => {
  const plan = planFigmaCommand(['inspect', '1-2', '--format', 'yaml'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(inspectPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['inspect', '1:2', '--format', 'yaml']);
  const result = await executeInspectPlan(plan, { evaluate: async () => RESULT });
  assert.match(result.stdout, /name: Card/);
  await assert.rejects(
    () => executeInspectPlan({ ...plan }, { evaluate: async () => RESULT }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(inspectPlanRoute(planFigmaCommand(['find', 'Card'])), 'not-inspect');
});

test('inspect planning keeps URL target identity separate from canonical node argv', () => {
  const url = 'https://www.figma.com/design/FILEA/Inspect-Lab?node-id=12-34';
  const planningArgv = inspectPlanningArgvFromRequest({ nodeId: url, format: 'yaml' });
  assert.equal(planningArgv[1], url);
  const plan = planFigmaCommand(planningArgv, { adapter: 'cli' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.target.source, 'figma-url');
  assert.deepEqual(plan.argv, ['inspect', '12:34', '--format', 'yaml']);
});
