import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../src/lib/protocol-contract.js';
import {
  executeNodeCss,
  executeNodeCssPlan,
  nodeCssPlanRoute,
  nodeCssPlanningArgvFromRequest,
} from '../src/application/node-css-command.js';
import {
  acceptsNodeCssArgv,
  nodeCssArgvFromRequest,
  parseNodeCssRequest,
} from '../src/application/node-css-request.js';
import {
  MAX_NATIVE_CSS_PROPERTIES,
  MAX_NATIVE_CSS_PROPERTY_CODE_UNITS,
  MAX_NATIVE_CSS_VALUE_CODE_UNITS,
} from '../src/lib/native-node-data.js';

const RESULT = {
  id: '1:2',
  name: 'Card',
  type: 'FRAME',
  css: { display: 'flex', 'border-radius': '12px' },
};

test('Node CSS request closes and canonicalizes the complete CLI surface', () => {
  assert.deepEqual(parseNodeCssRequest(['node', 'css', '--json', '1-2']), {
    nodeId: '1:2', json: true, warning: '',
  });
  assert.deepEqual(nodeCssArgvFromRequest({ nodeId: '1-2', json: true }),
    ['node', 'css', '1:2', '--json']);
  for (const argv of [
    ['node', 'css'],
    ['node', 'css', '1:2', '3:4'],
    ['node', 'css', '--future', 'private-value'],
    ['node', 'css', '--json', '--json', '1:2'],
    ['node', 'css', 'not-a-node'],
  ]) assert.equal(acceptsNodeCssArgv(argv), false, argv.join(' '));
});

test('Node CSS Command Application returns native Inspect CSS in text and JSON', async () => {
  let code = '';
  const textResult = await executeNodeCss({ nodeId: '1-2' }, {
    evaluate: async (value) => { code = value; return RESULT; },
  });
  assert.match(code, /getCSSAsync\(\)/);
  assert.equal(textResult.stdout, '/* Card (1:2) — FRAME */\ndisplay: flex;\nborder-radius: 12px;');
  const jsonResult = await executeNodeCss({ nodeId: '1:2', json: true }, {
    evaluate: async () => RESULT,
  });
  assert.deepEqual(JSON.parse(jsonResult.stdout), RESULT);
});

test('Node CSS keeps its worst-case result beneath the Plugin protocol limit', async () => {
  const oversized = {
    ...RESULT,
    css: Object.fromEntries(Array.from({ length: MAX_NATIVE_CSS_PROPERTIES + 1 }, (_, index) => [
      `property-${index}`, 'value',
    ])),
  };
  await assert.rejects(
    () => executeNodeCss({ nodeId: '1:2' }, { evaluate: async () => oversized }),
    /invalid or unbounded native CSS data/,
  );
  assert.ok(
    MAX_NATIVE_CSS_PROPERTIES
      * (MAX_NATIVE_CSS_PROPERTY_CODE_UNITS + MAX_NATIVE_CSS_VALUE_CODE_UNITS) * 4
      + 96_000 < MAX_PROTOCOL_VALUE_BYTES,
    'worst-case UTF-8 plus object framing must remain below the Plugin value cap',
  );
});

test('Node CSS Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand(['node', 'css', '1-2', '--json'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(nodeCssPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['node', 'css', '1:2', '--json']);
  assert.deepEqual((await executeNodeCssPlan(plan, { evaluate: async () => RESULT })).result, RESULT);
  await assert.rejects(
    () => executeNodeCssPlan({ ...plan }, { evaluate: async () => RESULT }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(nodeCssPlanRoute(planFigmaCommand(['node', 'bindings'], { adapter: 'mcp' })), 'not-node-css');
});

test('Node CSS planning keeps an option-first URL target separate from canonical argv', () => {
  const url = 'https://www.figma.com/design/FILEA/CSS-Lab?node-id=12-34';
  const planningArgv = nodeCssPlanningArgvFromRequest({ nodeId: url, json: true });
  assert.equal(planningArgv[2], url);
  const typed = planFigmaCommand(planningArgv, { adapter: 'mcp' });
  const optionFirst = planFigmaCommand(['node', 'css', '--json', url], { adapter: 'mcp' });
  assert.equal(typed.target.fileKey, 'FILEA');
  assert.equal(optionFirst.target.fileKey, 'FILEA');
  assert.deepEqual(optionFirst.argv, ['node', 'css', '12:34', '--json']);
});
