import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executePageStructure,
  executePageStructurePlan,
  pageStructurePlanRoute,
} from '../src/application/page-structure-command.js';
import {
  acceptsPageStructureArgv,
  pageStructureArgvFromRequest,
  parsePageStructureRequest,
} from '../src/application/page-structure-request.js';

test('Page Structure request closes and canonicalizes both writes', () => {
  assert.deepEqual(parsePageStructureRequest([
    'canvas', 'page-create', '--no-switch', '--', '--Draft',
  ]), { action: 'page-create', name: '--Draft', switchPage: false });
  assert.deepEqual(parsePageStructureRequest([
    'canvas', 'page-divider', '--json', '--index=2', '——',
  ]), { action: 'page-divider', name: '——', index: 2, json: true });
  assert.deepEqual(pageStructureArgvFromRequest({
    action: 'page-create', name: '--Draft', switchPage: false,
  }), ['canvas', 'page-create', '--no-switch', '--', '--Draft']);
  assert.deepEqual(pageStructureArgvFromRequest({
    action: 'page-divider', name: '——', index: 2, json: true,
  }), ['canvas', 'page-divider', '--index', '2', '--json', '——']);

  for (const argv of [
    ['canvas', 'page-create'],
    ['canvas', 'page-create', 'One', 'Two'],
    ['canvas', 'page-create', '--no-switch', '--no-switch', 'One'],
    ['canvas', 'page-divider', 'One', 'Two'],
    ['canvas', 'page-divider', '--json', '--json'],
    ['canvas', 'page-divider', '--index'],
    ['canvas', 'page-divider', '--index', '-1'],
    ['canvas', 'page-divider', '--index', '4097'],
    ['canvas', 'page-divider', '--future'],
    ['canvas', 'page-divider', 'Library'],
  ]) assert.equal(acceptsPageStructureArgv(argv), false, argv.join(' '));
});

test('Page creation preserves output and owns duplicate failure', async () => {
  let code = '';
  const result = await executePageStructure({
    action: 'page-create', name: 'Foundations', switchPage: true,
  }, {
    evaluate: async (value) => {
      code = value;
      return { status: 'created', id: '0:3', name: 'Foundations', switched: true };
    },
  });
  assert.match(code, /figma\.createPage\(\)/);
  assert.match(code, /setCurrentPageAsync\(page\)/);
  assert.ok(code.indexOf('find((entry) => entry.name === name)') < code.indexOf('figma.createPage()'));
  assert.match(code, /page\.remove\(\)/);
  assert.equal(result.stdout, '✓ Created page: Foundations (0:3) — now current');

  await assert.rejects(
    () => executePageStructure({ action: 'page-create', name: 'Foundations' }, {
      evaluate: async () => ({ status: 'duplicate', id: '0:1', name: 'Foundations' }),
    }),
    /Page already exists: Foundations \(0:1\)/,
  );
});

test('Page creation reports cleanup truthfully when a later step fails', async () => {
  await assert.rejects(
    () => executePageStructure({ action: 'page-create', name: 'One' }, {
      evaluate: async () => ({ status: 'mutation-failed', cleanup: 'removed' }),
    }),
    /created page was removed/,
  );
  await assert.rejects(
    () => executePageStructure({ action: 'page-create', name: 'One' }, {
      evaluate: async () => ({ status: 'mutation-failed', cleanup: 'partial-residue' }),
    }),
    /created page may remain/,
  );
});

test('Page divider preflights index before creation and supports JSON', async () => {
  let code = '';
  const result = await executePageStructure({
    action: 'page-divider', name: '——', index: 2, json: true,
  }, {
    evaluate: async (value) => {
      code = value;
      return {
        status: 'created', id: '0:4', name: '——', index: 2, isPageDivider: true,
      };
    },
  });
  assert.ok(code.indexOf("status: 'index-out-of-range'") < code.indexOf('figma.createPageDivider'));
  assert.match(code, /divider\.remove\(\)/);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: '0:4', name: '——', index: 2, isPageDivider: true,
  });

  await assert.rejects(
    () => executePageStructure({ action: 'page-divider', index: 8 }, {
      evaluate: async () => ({ status: 'index-out-of-range', maximum: 3 }),
    }),
    /Index out of range: 8 \(maximum 3\)/,
  );
});

test('Page divider text and cleanup failures are bounded', async () => {
  const result = await executePageStructure({ action: 'page-divider' }, {
    evaluate: async () => ({
      status: 'created', id: '0:4', name: '', index: 3, isPageDivider: true,
    }),
  });
  assert.equal(result.stdout, '✓ Created page divider (0:4)');
  await assert.rejects(
    () => executePageStructure({ action: 'page-divider', index: 1 }, {
      evaluate: async () => ({ status: 'mutation-failed', cleanup: 'partial-residue' }),
    }),
    /created page divider may remain/,
  );
  await assert.rejects(
    () => executePageStructure({ action: 'page-divider' }, {
      evaluate: async () => ({
        status: 'created', id: '', name: '', index: 0, isPageDivider: true,
      }),
    }),
    /invalid Page Structure result/,
  );
});

test('Page Structure accepts only authentic non-retrying write Plans', async () => {
  const create = planFigmaCommand(['canvas', 'page-create', 'One'], { adapter: 'mcp' });
  const createWithoutSwitch = planFigmaCommand([
    'canvas', 'page-create', '--no-switch', 'Two',
  ], { adapter: 'mcp' });
  const divider = planFigmaCommand(['canvas', 'page-divider', '--json'], { adapter: 'mcp' });
  for (const plan of [create, divider]) {
    assert.equal(plan.allowed, true);
    assert.equal(plan.effects.figma, 'write');
    assert.equal(plan.execution.retry, 'never');
    assert.equal(pageStructurePlanRoute(plan), 'command-application');
  }
  assert.equal(create.effects.editor, 'write');
  assert.equal(createWithoutSwitch.effects.editor, 'none');
  assert.equal(divider.effects.editor, 'none');
  assert.deepEqual((await executePageStructurePlan(create, {
    evaluate: async () => ({ status: 'created', id: '0:3', name: 'One', switched: true }),
  })).result, { id: '0:3', name: 'One', switched: true });
  await assert.rejects(
    () => executePageStructurePlan({ ...create }, { evaluate: async () => null }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(pageStructurePlanRoute(planFigmaCommand(['canvas', 'pages'])),
    'not-page-structure');
});

test('Page Structure resolves policy-identical CLI and MCP Plans', () => {
  for (const argv of [
    ['canvas', 'page-create', '--no-switch', 'One'],
    ['canvas', 'page-divider', '--index=2', '--json', '——'],
  ]) {
    const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEPLACEHOLDER' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEPLACEHOLDER' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
    const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
    assert.deepEqual(cliPolicy, mcpPolicy);
  }
});
