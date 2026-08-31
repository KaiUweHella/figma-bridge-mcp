import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  designSourceImportPlanRoute,
  designSourceImportRequiresFigma,
  executeDesignSourceImportPlan,
  prepareDesignSourceImportPlan,
} from '../src/application/design-source-import-command.js';
import {
  acceptsDesignSourceImportArgv,
  designSourceImportArgvFromRequest,
  parseDesignSourceImportRequest,
} from '../src/application/design-source-import-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const SOURCE = '/workspace/source.css';

function converted({ items = true, components = [] } = {}) {
  return {
    tokens: {
      color: items ? { brand: '#336699' } : {},
      radius: items ? { card: 12 } : {},
      spacing: items ? { stack: 8 } : {},
      typography: {},
      shadow: {},
    },
    meta: { source: 'Converted Fixture', components },
    designMd: '# DESIGN.md — Converted Fixture\n',
  };
}

function plan(request, options = {}) {
  return planFigmaCommand(designSourceImportArgvFromRequest({
    source: SOURCE,
    collection: null,
    printContext: false,
    save: null,
    type: 'css',
    forceSlash: false,
    ...request,
  }), { adapter: 'cli', workspaceDir: '/workspace', ...options });
}

function readableIO(overrides = {}) {
  return {
    limits: {
      textBytes: 8 * 1024 * 1024,
      nestingDepth: 64,
      collectionEntries: 100_000,
      yamlAliases: 50,
    },
    readText: () => '# fixture',
    ...overrides,
  };
}

test('Design Source Import request is closed, canonical, and slash-intent aware', () => {
  const request = parseDesignSourceImportRequest([
    'import', '-cTheme', '--save=DESIGN.generated.md', '--type', 'css', '--force-slash',
    '--', '-source.css',
  ]);
  assert.deepEqual(request, {
    source: '-source.css',
    collection: 'Theme',
    printContext: false,
    save: 'DESIGN.generated.md',
    type: 'css',
    forceSlash: true,
  });
  assert.deepEqual(designSourceImportArgvFromRequest(request), [
    'import', '--collection=Theme', '--save=DESIGN.generated.md', '--type=css',
    '--force-slash', '--', '-source.css',
  ]);
  for (const argv of [
    ['import'],
    ['import', 'one.css', 'two.css'],
    ['import', '--future', 'secret', 'source.css'],
    ['import', '--type=unknown', 'source.css'],
    ['import', '--save', '--print-context', 'source.css'],
    ['import', '--collection=A/B', 'source.css'],
    ['import', '--collection=A/B', '--print-context', '--force-slash', 'source.css'],
    ['import', '--type=css', '--type=tokens', 'source.css'],
  ]) assert.equal(acceptsDesignSourceImportArgv(argv), false, argv.join(' '));
  assert.throws(() => designSourceImportArgvFromRequest({
    source: SOURCE, future: true,
  }), /closed object/);
});

test('print-context Plan owns one repository-only read with no Figma target or dispatch', () => {
  const cli = plan({ printContext: true });
  const mcp = planFigmaCommand(cli.argv, { adapter: 'mcp', workspaceDir: '/workspace' });
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'import');
  assert.equal(designSourceImportPlanRoute(cli), 'command-application');
  assert.deepEqual(cli.effects, {
    figma: 'none', editor: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.equal(cli.target.kind, 'none');
  assert.equal(cli.confirmation, 'none');
  assert.equal(cli.execution.pluginDispatch, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.deepEqual(mcp.argv, cli.argv);
  assert.deepEqual(mcp.effects, cli.effects);
  assert.deepEqual(mcp.target, cli.target);
  assert.deepEqual(mcp.execution, cli.execution);
});

test('syntactically explicit and remote Storybook imports stay repository/network utility reads', () => {
  for (const commandPlan of [
    plan({ type: 'storybook' }),
    planFigmaCommand(['import', '--', 'https://storybook.example.com'], {
      adapter: 'mcp', workspaceDir: '/workspace',
    }),
  ]) {
    assert.equal(commandPlan.effects.figma, 'none');
    assert.equal(commandPlan.target.kind, 'none');
    assert.equal(commandPlan.confirmation, 'none');
    assert.equal(commandPlan.execution.pluginDispatch, 'none');
  }
});

test('path policy records only the original source and explicit output roles', () => {
  const context = plan({ printContext: true });
  assert.equal(context.effects.workspace, 'read');
  assert.deepEqual(context.audit.outputRoles, []);
  assert.equal(context.outputs.length, 0);

  const saved = plan({ printContext: true, save: '/workspace/generated/DESIGN.md' });
  assert.equal(saved.effects.workspace, 'write');
  assert.deepEqual(saved.audit.outputRoles, ['import-output']);
  assert.deepEqual(saved.outputs.map((output) => output.role), ['import-output']);
  assert.doesNotMatch(JSON.stringify(context), /DESIGN-storybook\.md/);
  assert.doesNotMatch(JSON.stringify(saved), /DESIGN-storybook\.md/);
});

test('converted context prepares and executes without Plugin evaluation or writable IO', async () => {
  const commandPlan = plan({ printContext: true });
  const prepared = await prepareDesignSourceImportPlan(commandPlan, {
    workspaceIO: readableIO(),
    convertSource: async (source, options) => {
      assert.equal(source, SOURCE);
      assert.equal(options.type, 'css');
      assert.equal(options.workspaceIO.readText instanceof Function, true);
      return converted();
    },
  });
  assert.equal(prepared.kind, 'context-only');
  assert.equal(designSourceImportRequiresFigma(prepared), false);
  const result = await executeDesignSourceImportPlan(commandPlan, prepared, {
    workspaceIO: readableIO(),
    evaluate: async () => { throw new Error('context import must not evaluate'); },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Design system loaded: Converted Fixture/);
  assert.match(result.stdout, /Spacing tokens \(1\): stack/);
});

test('explicit save is the only converted artifact write', async () => {
  const target = '/workspace/generated/DESIGN.md';
  const commandPlan = plan({ printContext: true, save: target });
  const writes = [];
  const io = readableIO({ write: (...args) => writes.push(args) });
  const prepared = await prepareDesignSourceImportPlan(commandPlan, {
    workspaceIO: io, convertSource: async () => converted(),
  });
  await executeDesignSourceImportPlan(commandPlan, prepared, { workspaceIO: io });
  assert.deepEqual(writes, [[
    target, '# DESIGN.md — Converted Fixture\n',
    { role: 'import-output', createParents: true },
  ]]);
});

test('converted variables reuse the journaled Single-Collection mutation', async () => {
  const commandPlan = plan({ collection: 'Owned Import' });
  const prepared = await prepareDesignSourceImportPlan(commandPlan, {
    workspaceIO: readableIO(), convertSource: async () => converted(),
  });
  assert.equal(prepared.kind, 'single-collection');
  assert.equal(prepared.tokenImport.request.collection, 'Owned Import');
  assert.equal(designSourceImportRequiresFigma(prepared), true);
  assert.deepEqual(prepared.tokenImport.items.map(({ name, type, scopes }) => ({ name, type, scopes })), [
    { name: 'brand', type: 'COLOR', scopes: undefined },
    { name: 'card', type: 'FLOAT', scopes: ['CORNER_RADIUS'] },
    { name: 'stack', type: 'FLOAT', scopes: ['GAP'] },
  ]);
  const result = await executeDesignSourceImportPlan(commandPlan, prepared, {
    workspaceIO: readableIO(),
    evaluate: async () => JSON.stringify({
      schemaVersion: 1,
      status: 'complete',
      collection: { id: 'c1', name: 'Owned Import', created: true, modeId: 'm1' },
      created: { total: 3, indexes: [0, 1, 2] },
      matching: { total: 0, indexes: [] },
      residue: { total: 0, items: [], omitted: 0 },
    }),
  });
  assert.match(result.stdout, /Imported 3 token\(s\)/);
  assert.match(result.stdout, /agent context summary/);
  assert.equal(result.result.collection.name, 'Owned Import');
});

test('converted composites share the owning import lifecycle with Variables', async () => {
  const commandPlan = plan({ collection: 'Composite Import' });
  const prepared = await prepareDesignSourceImportPlan(commandPlan, {
    workspaceIO: readableIO(),
    convertSource: async () => ({
      ...converted(),
      tokens: {
        ...converted().tokens,
        typography: { Body: { fontFamily: 'Inter', fontSize: 16 } },
        shadow: {},
      },
    }),
  });
  assert.equal(prepared.kind, 'native-design');
  let evaluations = 0;
  const style = { id: 'S:1', key: 'K:1', name: 'Body', type: 'TEXT', remote: false };
  const result = await executeDesignSourceImportPlan(commandPlan, prepared, {
    workspaceIO: readableIO(),
    evaluate: async () => {
      evaluations++;
      return evaluations === 1 ? JSON.stringify({
        schemaVersion: 1, status: 'complete',
        collection: { id: 'c1', name: 'Composite Import', created: true, modeId: 'm1' },
        created: { total: 3, indexes: [0, 1, 2] },
        matching: { total: 0, indexes: [] },
        residue: { total: 0, items: [], omitted: 0 },
      }) : JSON.stringify({
        schemaVersion: 1, status: 'complete',
        created: { total: 1, items: [style], omitted: 0 },
        matching: { total: 0, items: [], omitted: 0 },
        verified: { total: 1, items: [style], omitted: 0 },
        unsupported: [], residue: { total: 0, items: [], omitted: 0 },
      });
    },
  });
  assert.equal(evaluations, 2);
  assert.equal(result.result.variables.collection.name, 'Composite Import');
  assert.equal(result.result.styles.created, 1);
});

test('top-level DESIGN.md reuses its exact prepared import without a nested Plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-design-source-'));
  const source = join(root, 'DESIGN.md');
  writeFileSync(source, `# Owned DESIGN.md

## Machine-readable tokens
\`\`\`json design-tokens
${JSON.stringify({
    color: { brand: '#336699' },
    radius: {}, spacing: {}, typography: {}, shadow: {},
    meta: { source: 'Owned DESIGN Fixture' },
  })}
\`\`\`
`);
  const workspaceIO = createWorkspaceIO({ root });
  const commandPlan = planFigmaCommand(designSourceImportArgvFromRequest({
    source,
    collection: 'Owned DESIGN Import',
    printContext: false,
    save: null,
    type: 'designmd',
    forceSlash: false,
  }), { adapter: 'cli', workspaceDir: root, workspaceIO });
  const prepared = await prepareDesignSourceImportPlan(commandPlan, { workspaceIO });
  assert.equal(prepared.kind, 'design-md');
  assert.equal(prepared.designMd.kind, 'single-collection');
  assert.equal(designSourceImportRequiresFigma(prepared), true);
  const result = await executeDesignSourceImportPlan(commandPlan, prepared, {
    workspaceIO,
    evaluate: async () => JSON.stringify({
      schemaVersion: 1,
      status: 'complete',
      collection: {
        id: 'c1', name: 'Owned DESIGN Import', created: true, modeId: 'm1',
      },
      created: { total: 1, indexes: [0] },
      matching: { total: 0, indexes: [] },
      residue: { total: 0, items: [], omitted: 0 },
    }),
  });
  assert.match(result.stdout, /Imported 1 token\(s\)/);
});

test('Storybook component context stays useful without an implicit file or Plugin write', async () => {
  const commandPlan = plan({ type: 'storybook' });
  const prepared = await prepareDesignSourceImportPlan(commandPlan, {
    workspaceIO: readableIO(),
    convertSource: async () => converted({
      items: false,
      components: [{ name: 'Button', variants: ['Primary', 'Secondary'] }],
    }),
  });
  assert.equal(prepared.kind, 'context-only');
  assert.equal(designSourceImportRequiresFigma(prepared), false);
  const result = await executeDesignSourceImportPlan(commandPlan, prepared, {
    workspaceIO: readableIO(),
  });
  assert.match(result.stdout, /Button \(2 variants\)/);
});

test('execution rejects forged preparation and a preparation from another Plan', async () => {
  const first = plan({ collection: 'First' });
  const second = plan({ collection: 'Second' });
  const prepared = await prepareDesignSourceImportPlan(first, {
    workspaceIO: readableIO(), convertSource: async () => converted(),
  });
  await assert.rejects(
    () => executeDesignSourceImportPlan(first, { ...prepared }, { workspaceIO: readableIO() }),
    /authentic prepared source/,
  );
  await assert.rejects(
    () => executeDesignSourceImportPlan(second, prepared, { workspaceIO: readableIO() }),
    /authentic prepared source/,
  );
});
