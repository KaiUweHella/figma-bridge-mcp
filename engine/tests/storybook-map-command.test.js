import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStorybookMapPlan,
  prepareStorybookMapPlan,
  storybookMapPlanRoute,
} from '../src/application/storybook-map-command.js';
import {
  acceptsStorybookMapArgv,
  parseStorybookMapRequest,
  storybookMapArgvFromRequest,
} from '../src/application/storybook-map-request.js';

const SOURCE = '/workspace/storybook';
const OUTPUT = '/workspace/maps/figma-map.json';
const STORYBOOK = JSON.stringify({
  entries: {
    'components-button--primary': {
      type: 'story',
      id: 'components-button--primary',
      title: 'Components/Button',
      name: 'Primary',
      importPath: './Button.stories.tsx',
    },
  },
});

function commandPlan(overrides = {}, options = {}) {
  return planFigmaCommand(storybookMapArgvFromRequest({
    source: SOURCE,
    output: OUTPUT,
    json: false,
    currentPage: false,
    ...overrides,
  }), { adapter: 'cli', workspaceDir: '/workspace', ...options });
}

function inventory(scope = 'ALL_PAGES') {
  return {
    schemaVersion: 1,
    scope,
    visited: 2,
    pagesScanned: 1,
    fileName: 'Neutral Mapping Fixture',
    componentSets: [{
      id: '1:1',
      name: 'Button',
      page: 'Components',
      key: 'set-key',
      defaultVariantId: '1:2',
      variantAxes: { State: { values: ['Primary'] } },
      variants: [{ id: '1:2', name: 'State=Primary', key: 'variant-key' }],
    }],
    standaloneComponents: [],
  };
}

function fakeIO(overrides = {}) {
  return {
    limits: {
      jsonBytes: 8 * 1024 * 1024,
      textBytes: 8 * 1024 * 1024,
      binaryBytes: 64 * 1024 * 1024,
      nestingDepth: 64,
      collectionEntries: 100_000,
      yamlAliases: 50,
    },
    exists: () => false,
    readJson: () => { throw new Error('unexpected read'); },
    write: () => {},
    ...overrides,
  };
}

async function prepared(plan = commandPlan(), io = fakeIO()) {
  return prepareStorybookMapPlan(plan, {
    workspaceIO: io,
    fetchIndex: async (source, options) => {
      assert.equal(source, parseStorybookMapRequest(plan.argv).source);
      assert.equal(options.workspaceIO, io);
      return STORYBOOK;
    },
  });
}

test('Storybook Map request is closed, canonical, and literal-safe', () => {
  const request = parseStorybookMapRequest([
    'map', 'storybook', '-omaps/result.json', '--json', '--current-page', '--', '-storybook',
  ]);
  assert.deepEqual(request, {
    source: '-storybook',
    output: 'maps/result.json',
    json: true,
    currentPage: true,
  });
  assert.deepEqual(storybookMapArgvFromRequest(request), [
    'map', 'storybook', '--output', 'maps/result.json', '--json', '--current-page', '--', '-storybook',
  ]);
  for (const argv of [
    ['map', 'storybook'],
    ['map', 'storybook', 'one', 'two'],
    ['map', 'storybook', '--future', 'secret', 'source'],
    ['map', 'storybook', '--output'],
    ['map', 'storybook', '--output=a', '-ob', 'source'],
    ['map', 'storybook', '--json', '--json', 'source'],
    ['map', 'storybook', '--current-page', '--current-page', 'source'],
  ]) assert.equal(acceptsStorybookMapArgv(argv), false, argv.join(' '));
  assert.throws(() => storybookMapArgvFromRequest({ source: SOURCE, future: true }), /closed object/);
});

test('CLI and MCP own one canonical Storybook Map Plan', () => {
  const cli = commandPlan();
  const mcp = planFigmaCommand(cli.argv, { adapter: 'mcp', workspaceDir: '/workspace' });
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'map.storybook');
  assert.equal(storybookMapPlanRoute(cli), 'command-application');
  assert.deepEqual(cli.effects, {
    figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.equal(cli.target.kind, 'plugin-file');
  assert.equal(cli.execution.pluginDispatch, 'serialized');
  assert.equal(cli.execution.retry, 'never');
  assert.deepEqual(cli.audit.outputRoles, ['component-map-output']);
  assert.deepEqual(mcp.argv, cli.argv);
  assert.deepEqual(mcp.effects, cli.effects);
  assert.deepEqual(mcp.target, cli.target);
  assert.deepEqual(mcp.execution, cli.execution);

  const remote = planFigmaCommand([
    'map', 'storybook', 'https://storybook.example.test', '--json',
  ], { adapter: 'mcp', workspaceDir: '/workspace' });
  assert.equal(remote.allowed, true);
  assert.equal(remote.effects.network, 'read');
  assert.equal(remote.argv.at(-1), 'https://storybook.example.test');
});

test('Storybook Map prepares its source before one bounded Figma inventory and publication', async () => {
  const plan = commandPlan();
  const writes = [];
  const io = fakeIO({ write: (...args) => writes.push(args) });
  const source = await prepared(plan, io);
  let code = '';
  const result = await executeStorybookMapPlan(plan, source, {
    workspaceIO: io,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
    evaluate: async (value) => { code = value; return inventory(); },
  });
  assert.match(code, /figma\.loadAllPagesAsync\(\)/);
  assert.match(code, /MAX|limit exceeded/i);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].slice(0, 1), [OUTPUT]);
  assert.deepEqual(writes[0][2], { role: 'component-map-output', createParents: true });
  const saved = JSON.parse(writes[0][1]);
  assert.equal(saved.generatedAt, '2026-08-31T10:00:00.000Z');
  assert.equal(saved.figmaFile, 'Neutral Mapping Fixture');
  assert.equal(saved.mappings.length, 1);
  assert.equal(saved.mappings[0].figmaKey, 'set-key');
  assert.equal(saved.mappings[0].figmaVariantKey, 'variant-key');
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /1 mapped \(1 high \/ 0 medium \/ 0 low\)/);
  assert.match(result.stdout, /Written to \/workspace\/maps\/figma-map\.json/);
});

test('current-page JSON output preserves exact inventory scope', async () => {
  const plan = commandPlan({ currentPage: true, json: true });
  const io = fakeIO();
  const source = await prepared(plan, io);
  let code = '';
  const result = await executeStorybookMapPlan(plan, source, {
    workspaceIO: io,
    now: () => '2026-08-31T10:00:00.000Z',
    evaluate: async (value) => { code = value; return inventory('CURRENT_PAGE'); },
  });
  assert.doesNotMatch(code, /figma\.loadAllPagesAsync\(\)/);
  assert.equal(JSON.parse(result.stdout).mappings.length, 1);
  await assert.rejects(() => executeStorybookMapPlan(plan, source, {
    workspaceIO: io,
    evaluate: async () => inventory('ALL_PAGES'),
  }), /mismatched component scan scope/);
});

test('manual mappings survive and malformed prior maps remain an explicit warning', async () => {
  const plan = commandPlan();
  const manual = {
    figmaName: 'Pinned Button', figmaPage: 'Manual', figmaKey: 'manual-key',
    figmaVariantKey: null, figmaNodeId: '9:9', storyTitle: 'Pinned/Button',
    storyId: 'pinned--button', importPath: './Pinned.stories.tsx', stories: [],
    confidence: 'high', matchedBy: 'manual',
  };
  const pinnedIO = fakeIO({
    exists: () => true,
    readJson: () => ({ mappings: [manual] }),
  });
  const pinned = await prepared(plan, pinnedIO);
  const pinnedResult = await executeStorybookMapPlan(plan, pinned, {
    workspaceIO: pinnedIO,
    evaluate: async () => inventory(),
  });
  assert.equal(pinnedResult.result.mappings[0], manual);
  assert.match(pinnedResult.stdout, /1 manual/);

  const invalidIO = fakeIO({ exists: () => true, readJson: () => ({ version: 1 }) });
  const invalid = await prepared(plan, invalidIO);
  const invalidResult = await executeStorybookMapPlan(plan, invalid, {
    workspaceIO: invalidIO,
    evaluate: async () => inventory(),
  });
  assert.match(invalidResult.stderr, /not a valid component map — overwriting/);
});

test('Storybook Map rejects forged preparation, invalid inventory, and oversized output', async () => {
  const plan = commandPlan();
  const io = fakeIO();
  await assert.rejects(() => executeStorybookMapPlan(plan, {
    request: parseStorybookMapRequest(plan.argv), storyComponents: [], existing: null, warning: '',
  }, { workspaceIO: io, evaluate: async () => inventory() }), /authentic prepared source/);

  const source = await prepared(plan, io);
  await assert.rejects(() => executeStorybookMapPlan(plan, source, {
    workspaceIO: io,
    evaluate: async () => ({ ...inventory(), extra: 'forged' }),
  }), /invalid bounded result/);
  await assert.rejects(() => executeStorybookMapPlan(plan, source, {
    workspaceIO: fakeIO({ limits: { ...io.limits, jsonBytes: 32 } }),
    evaluate: async () => inventory(),
  }), /output exceeds the Workspace JSON limit/);
});

test('Storybook source failures happen before any Figma evaluation', async () => {
  const plan = commandPlan();
  let evaluations = 0;
  await assert.rejects(() => prepareStorybookMapPlan(plan, {
    workspaceIO: fakeIO(),
    fetchIndex: async () => { throw new Error('fixture source unavailable'); },
    evaluate: async () => { evaluations++; },
  }), /fixture source unavailable/);
  assert.equal(evaluations, 0);
});
