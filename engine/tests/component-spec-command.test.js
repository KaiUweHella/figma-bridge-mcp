import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentSpecMeasureCode,
  componentSpecPlanRoute,
  executeComponentSpecPlan,
  MAX_COMPONENT_SPEC_RESULT_CODE_UNITS,
  prepareComponentSpecPlan,
} from '../src/application/component-spec-command.js';
import {
  acceptsComponentSpecArgv,
  componentSpecArgvFromRequest,
  componentSpecFigmaUrlFileKeyFromArgv,
  componentSpecPlanningArgvFromRequest,
  parseComponentSpecRequest,
} from '../src/application/component-spec-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const MARKDOWN = `# DESIGN.md -- Neutral

## 6. Components

### Button

Page: Components · 12 variants

| Property | Values |
|---|---|
| Variant | Primary, Secondary |
| Size | Small, Medium |

Sample variant structure:

- **Variant=Primary, Size=Medium** · \`COMPONENT\` · 71×32 · horizontal row, gap 8px, padding 6/12/6/12px · 1 children
  - **Text** · \`TEXT\` · 45×17 · "Button"
`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'component-spec-'));
  const file = join(root, 'DESIGN.md');
  writeFileSync(file, MARKDOWN);
  return { root, file, io: createWorkspaceIO({ root }) };
}

function figmaFixture({ padding = [6, 12, 6, 12] } = {}) {
  const text = { name: 'Text', type: 'TEXT', width: 45, height: 17 };
  const variant = {
    name: 'Variant=Primary, Size=Medium', type: 'COMPONENT', width: 71, height: 32,
    layoutMode: 'HORIZONTAL', itemSpacing: 8,
    paddingTop: padding[0], paddingRight: padding[1], paddingBottom: padding[2], paddingLeft: padding[3],
    children: [text],
  };
  const node = {
    id: '1:1', name: 'Button', type: 'COMPONENT_SET', width: 71, height: 32,
    variantGroupProperties: { Variant: {}, Size: {} }, children: [variant],
  };
  return { getNodeByIdAsync: async (id) => id === node.id ? node : null };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Component Spec closes options, tolerance, literal components, and URL targeting', () => {
  const url = 'https://www.figma.com/design/FILEA/Neutral?node-id=1-1';
  const request = parseComponentSpecRequest([
    'spec', '--tolerance=.5', '-fDESIGN.md', '--check', url, '--', 'Button',
  ]);
  assert.deepEqual({ ...request, warning: '' }, {
    component: 'Button', file: 'DESIGN.md', checkNodeId: '1:1', tolerance: 0.5, warning: '',
  });
  assert.match(request.warning, /Safe Mode/);
  assert.equal(componentSpecFigmaUrlFileKeyFromArgv(['spec', 'Button', `--check=${url}`]), 'FILEA');
  assert.deepEqual(componentSpecArgvFromRequest({
    component: '--check', file: 'DESIGN.md', checkNodeId: '1-1', tolerance: 2,
  }), ['spec', '--file', 'DESIGN.md', '--check', '1:1', '--tolerance', '2', '--', '--check']);
  assert.deepEqual(componentSpecPlanningArgvFromRequest({
    component: 'Button', checkNodeId: url,
  }), ['spec', '--check', url, '--tolerance', '2', '--', 'Button']);
  for (const args of [
    ['spec'],
    ['spec', 'Button', 'Card'],
    ['spec', 'Button', '--file'],
    ['spec', 'Button', '--check', 'bad-node'],
    ['spec', 'Button', '--tolerance', '-1'],
    ['spec', 'Button', '--tolerance', '2px'],
    ['spec', 'Button', '--future', 'private-value'],
    ['spec', 'Button', '--file', 'one.md', '--file', 'two.md'],
  ]) assert.equal(acceptsComponentSpecArgv(args), false, args.join(' '));
});

test('Component Spec prepares and formats repository-only digest without Figma', async () => {
  const { file, io } = workspace();
  const plan = planFigmaCommand(componentSpecPlanningArgvFromRequest({ component: 'Button', file }), {
    adapter: 'mcp', workspaceDir: io.roots[0], workspaceIO: io,
  });
  const prepared = prepareComponentSpecPlan(plan, { workspaceIO: io });
  const result = await executeComponentSpecPlan(plan, prepared);
  assert.equal(plan.target.kind, 'none'); assert.equal(plan.execution.retry, 'never');
  assert.match(result.stdout, /^Button  \(12 variants · Components\)/);
  assert.match(result.stdout, /axes:\n  Variant: Primary, Secondary/);
  assert.match(result.stdout, /sample: Variant=Primary, Size=Medium → 71×32/);
  assert.match(result.stdout.split('\n').at(-1), /^\{"spec":/);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
});

test('Component Spec check proves identity and returns pass or findings as an answer', async () => {
  const { file, io } = workspace();
  const url = 'https://www.figma.com/design/FILEA/Neutral?node-id=1-1';
  const plan = planFigmaCommand(componentSpecPlanningArgvFromRequest({
    component: 'Button', file, checkNodeId: url, tolerance: 2,
  }), { adapter: 'mcp', workspaceDir: io.roots[0], workspaceIO: io });
  const prepared = prepareComponentSpecPlan(plan, { workspaceIO: io });
  const passed = await executeComponentSpecPlan(plan, prepared, { evaluate: evaluate(figmaFixture()) });
  assert.equal(plan.target.fileKey, 'FILEA'); assert.equal(plan.execution.retry, 'safe-read');
  assert.deepEqual(plan.execution.okExitCodes, [0, 1]);
  assert.equal(passed.code, 0); assert.equal(passed.result.pass, true);
  assert.match(passed.stdout, /✓ Conforms to spec\./); assert.equal(passed.stderr, '');

  const failed = await executeComponentSpecPlan(plan, prepared, {
    evaluate: evaluate(figmaFixture({ padding: [8, 8, 8, 8] })),
  });
  assert.equal(failed.code, 1); assert.equal(failed.result.pass, false);
  assert.match(failed.stdout, /padding/); assert.match(failed.stdout, /does NOT conform/);
});

test('Component Spec rejects missing sources before dispatch and mismatched preparation', async () => {
  const { root, io } = workspace();
  const missing = planFigmaCommand(componentSpecPlanningArgvFromRequest({
    component: 'Button', file: join(root, 'missing.md'), checkNodeId: '1:1',
  }), { adapter: 'mcp', workspaceDir: root });
  assert.throws(() => prepareComponentSpecPlan(missing, { workspaceIO: io }), /No DESIGN\.md found/);

  const file = join(root, 'DESIGN.md');
  const button = planFigmaCommand(componentSpecPlanningArgvFromRequest({ component: 'Button', file }), {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io,
  });
  const prepared = prepareComponentSpecPlan(button, { workspaceIO: io });
  const other = planFigmaCommand(componentSpecPlanningArgvFromRequest({ component: 'Other', file }), {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io,
  });
  await assert.rejects(() => executeComponentSpecPlan(other, prepared), /authentic prepared source/);
});

test('Component Spec rejects forged, wrong-identity, and oversized Plugin measurements', async () => {
  const { file, io } = workspace();
  const plan = planFigmaCommand(componentSpecPlanningArgvFromRequest({
    component: 'Button', file, checkNodeId: '1:1',
  }), { adapter: 'mcp', workspaceDir: io.roots[0], workspaceIO: io });
  const prepared = prepareComponentSpecPlan(plan, { workspaceIO: io });
  for (const value of [
    'not-json',
    JSON.stringify({ id: '2:2', type: 'COMPONENT_SET', name: 'Button', variants: [{ name: 'x', w: 1, h: 1 }] }),
    JSON.stringify({ id: '1:1', type: 'COMPONENT_SET', name: 'Button', variants: [], privateField: true }),
    'x'.repeat(MAX_COMPONENT_SPEC_RESULT_CODE_UNITS + 1),
  ]) await assert.rejects(
    () => executeComponentSpecPlan(plan, prepared, { evaluate: async () => value }),
    /invalid/i,
  );
});

test('Component Spec owns one canonical cross-Adapter conditional Plan', () => {
  const { file, io } = workspace();
  for (const request of [
    { component: 'Button', file },
    { component: 'Button', file, checkNodeId: '1:1', tolerance: 0 },
  ]) {
    const mcp = planFigmaCommand(componentSpecPlanningArgvFromRequest(request), {
      adapter: 'mcp', workspaceDir: io.roots[0], workspaceIO: io,
    });
    const cli = planFigmaCommand(mcp.argv, {
      adapter: 'cli', workspaceDir: io.roots[0], workspaceIO: io, fileKey: mcp.target.fileKey,
    });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.deepEqual(cli.effects, mcp.effects); assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(componentSpecPlanRoute(mcp), 'command-application');
  }
  assert.equal(componentSpecPlanRoute(planFigmaCommand(['inspect', '1:1'])), 'not-component-spec');
});

test('Component Spec measurement is bounded and never mutates Figma', () => {
  const source = componentSpecMeasureCode({
    component: 'Button', checkNodeId: '1:1', tolerance: 2,
  }, 'Variant=Primary, Size=Medium');
  assert.doesNotMatch(source, /setTimeout|\.remove\(|\.appendChild\(|\.resize\(|\bselection\s*=/);
  assert.match(source, /bounded node count/); assert.match(source, /bounded response limit/);
  assert.doesNotThrow(() => new Function('figma', `return ${source}`));
});
