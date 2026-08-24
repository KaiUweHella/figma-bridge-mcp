import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeCompoundSemanticRenderPlan,
  executeSemanticRenderPlan,
  formatSemanticRenderResult,
  prepareCompoundSemanticRenderPlan,
  prepareSemanticRenderPlan,
  semanticRenderOutcomeCode,
  semanticRenderPlanRoute,
  semanticRenderResultRows,
} from '../src/application/semantic-render-command.js';
import {
  MAX_SEMANTIC_RENDER_ARRAY_ITEMS,
  MAX_SEMANTIC_RENDER_STRING_CODE_POINTS,
  SEMANTIC_RENDER_OUTCOME_KIND,
  SEMANTIC_RENDER_OUTCOME_SCHEMA,
  semanticRenderOutcomeJson,
  semanticRenderOutcomeYaml,
} from '../src/lib/semantic-render-outcome.js';
import YAML from 'yaml';
import {
  acceptsSemanticRenderArgv,
  semanticCompoundRenderArgvFromRequest,
  semanticCompoundRenderRequestFromArgv,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderPolicyFromArgv,
  semanticRenderRequestFromArgv,
} from '../src/application/semantic-render-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const SIMPLE_JSX = '<Frame name="Card" flex="col"><Text>Hello</Text></Frame>';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-render-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, io: createWorkspaceIO({ root }) };
}

function renderPlan(t, argv = ['render', SIMPLE_JSX], options = {}) {
  const { root, io } = workspace(t);
  return {
    io,
    plan: planFigmaCommand(argv, {
      adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A', ...options,
    }),
  };
}

function compoundPlan(t, argv, options = {}) {
  const { root, io } = workspace(t);
  return {
    root,
    io,
    plan: planFigmaCommand(argv, {
      adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A', ...options,
    }),
  };
}

function nativeResult(overrides = {}) {
  return {
    id: '1:2',
    name: 'Card',
    executor: 'structured-v1',
    width: 240,
    height: 120,
    structuralReport: {
      version: 1,
      passed: true,
      summary: {
        nodes: 2, grids: 0, autoLayouts: 1, freeLayouts: 0,
        instances: 0, absoluteNodes: 0,
      },
      mismatchCount: 0,
    },
    mutationOutcome: 'completed',
    mutationReport: {
      version: 1,
      outcome: 'completed',
      created: 2,
      removed: 0,
      residueCount: 0,
      residue: [],
      residueTruncated: false,
    },
    ...overrides,
  };
}

function nativeBatchResult(count = 2, overrides = {}) {
  return {
    frames: Array.from({ length: count }, (_, index) => nativeResult({
      id: `${index + 10}:${index + 20}`,
      name: `Card ${index + 1}`,
      mutationOutcome: undefined,
      mutationReport: undefined,
    })),
    executor: 'structured-batch-v1',
    textStyleReport: { references: 0, reused: 0, created: 0, bound: 0 },
    mutationOutcome: 'completed',
    mutationReport: {
      version: 1, outcome: 'completed', created: count * 2, removed: 0,
      residueCount: 0, residue: [], residueTruncated: false,
    },
    ...overrides,
  };
}

function redispatchableCapabilityError() {
  return Object.assign(new Error('native capability unavailable'), {
    kind: 'plugin-capability',
    phase: 'plugin-dispatch',
    outcome: 'not-dispatched',
  });
}

test('Semantic Render request Interface closes argv before policy and preserves a literal boundary', () => {
  const request = semanticRenderRequestFromArgv([
    'render', '--preset', 'desktop', '--collection=Brand', '--keep-wrapper', SIMPLE_JSX,
    '--approve-fallback', 'font.named-faces,root', '--allow-free-layout=root.free',
  ]);
  assert.deepEqual(request, {
    jsx: SIMPLE_JSX,
    keepWrapper: true,
    collection: 'Brand',
    preset: 'desktop',
    manifest: null,
    approvedFallbacks: ['font.named-faces', 'root'],
    allowedFreePaths: ['root.free'],
  });
  assert.deepEqual(semanticRenderArgvFromRequest(request), [
    'render', SIMPLE_JSX, '--keep-wrapper', '--collection=Brand', '--preset=desktop',
    '--approve-fallback=font.named-faces,root', '--allow-free-layout=root.free',
  ]);
  const leadingDashValues = semanticRenderRequestFromArgv([
    'render', SIMPLE_JSX, '--collection=-Brand', '--manifest=-registry.json',
  ]);
  assert.deepEqual(semanticRenderArgvFromRequest(leadingDashValues), [
    'render', SIMPLE_JSX, '--collection=-Brand', '--manifest=-registry.json',
  ]);
  assert.deepEqual(semanticRenderArgvRoute(['render', '--', SIMPLE_JSX]), {
    kind: 'simple', reason: null,
  });

  for (const malformed of [
    ['render'],
    ['render', SIMPLE_JSX, 'second-root'],
    ['render', SIMPLE_JSX, '--future'],
    ['render', SIMPLE_JSX, '--preset'],
    ['render', SIMPLE_JSX, '--preset', 'watch'],
    ['render', SIMPLE_JSX, '--collection', 'A', '--collection', 'B'],
    ['render', SIMPLE_JSX, '--approve-fallback', Array.from({ length: 101 }, (_, index) => `fallback-${index}`).join(',')],
    ['render', SIMPLE_JSX, '--', '--structural-gate'],
    ['render', SIMPLE_JSX, '--', '--print-browser-capture'],
  ]) {
    assert.equal(acceptsSemanticRenderArgv(malformed), false, malformed.join(' '));
    assert.throws(() => semanticRenderArgvRoute(malformed), /Invalid render command/, malformed.join(' '));
    assert.equal(planFigmaCommand(malformed).allowed, false, malformed.join(' '));
  }
});

test('simple, compound and named compatibility Render modes remain explicitly reachable', (t) => {
  const cases = [
    { argv: ['render', SIMPLE_JSX], kind: 'simple', reason: null, write: true, target: 'figma' },
    {
      argv: ['render', '<Frame flex="row"><Frame name="Card 1"/><Frame name="Card 2"/></Frame>'],
      kind: 'compound', reason: 'auto-split', write: true, target: 'figma',
    },
    {
      argv: ['render', '<Frame><Image src="photo.png"/></Frame>'],
      kind: 'compatibility', reason: 'image-resolution', write: true, target: 'figma',
    },
    ...['https://example.test/a.png', 'assets/a.png', 'imgref:asset-1', 'data:image/png;base64,AA=='].map((value) => ({
      argv: ['render', `<Frame><Image src={${value}}/></Frame>`],
      kind: 'compatibility', reason: 'image-resolution', write: true, target: 'figma',
    })),
    { argv: ['render', '<Frame><Image src={"https://example.test/a.png"}/></Frame>'], kind: 'compatibility', reason: 'image-resolution', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '-x', '20'], kind: 'compatibility', reason: 'post-positioning', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--no-smart-position'], kind: 'compatibility', reason: 'post-positioning', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--as-component'], kind: 'compatibility', reason: 'component-conversion', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--verify'], kind: 'compound', reason: 'single-root-stages', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--icons', 'icons'], kind: 'compatibility', reason: 'project-icons', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--resize-probe'], kind: 'compatibility', reason: 'resize-probe', write: true, target: 'figma' },
    { argv: ['render', '--dom-capture', 'screen.json'], kind: 'compatibility', reason: 'dom-capture', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--structural-gate'], kind: 'compatibility', reason: 'structural-gate', write: false, target: 'none' },
    {
      argv: ['render', '<Frame flex="row"><Frame name="Card 1"><Text>One</Text></Frame><Frame name="Card 2"><Text>Two</Text></Frame></Frame>', '--structural-gate'],
      kind: 'compatibility', reason: 'structural-gate', write: false, target: 'none',
    },
    { argv: ['render', '--print-browser-capture', '.screen'], kind: 'compatibility', reason: 'browser-capture-expression', write: false, target: 'none' },
    { argv: ['render', '--help'], kind: 'help', reason: null, write: false, target: 'none' },
  ];

  const { root } = workspace(t);
  for (const expected of cases) {
    assert.deepEqual(semanticRenderArgvRoute(expected.argv), {
      kind: expected.kind, reason: expected.reason,
    });
    assert.deepEqual(semanticRenderPolicyFromArgv(expected.argv), {
      kind: expected.kind,
      reason: expected.reason,
      mutatesDesign: expected.write,
      target: expected.target,
    });
    const plan = planFigmaCommand(expected.argv, {
      adapter: 'mcp', workspaceDir: root, fileKey: 'FILE_A',
    });
    assert.equal(plan.allowed, true, expected.argv.join(' '));
    assert.equal(plan.effects.figma, expected.write ? 'write' : 'none', expected.argv.join(' '));
    assert.equal(plan.target.kind, expected.target === 'figma' ? 'plugin-file' : 'none', expected.argv.join(' '));
    assert.equal(
      semanticRenderPlanRoute(plan),
      expected.kind === 'simple'
        ? 'command-application'
        : expected.kind === 'compound' ? 'compound-command-application'
        : expected.kind === 'help' ? 'not-render' : 'commander-compatibility',
      expected.argv.join(' '),
    );
  }
});

test('render-batch is owned by the compound Command Application', (t) => {
  const { root, io } = workspace(t);
  const plan = planFigmaCommand([
    'render-batch', JSON.stringify(['<Frame name="Card"><Text>One</Text></Frame>']),
  ], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
  });

  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.target.kind, 'plugin-file');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(semanticRenderPlanRoute(plan), 'compound-command-application');
});

test('auto-split and explicit batch close the same option semantics', () => {
  const wrapper = '<Frame flex="row"><Frame name="Card 1"><Image src={assets/photo.png}/></Frame><Frame name="Card 2"><Image src="https://images.example/card.png"/></Frame></Frame>';
  const autoArgv = [
    'render', wrapper, '--gap=0', '--direction=col', '-x10', '-y20',
    '--no-smart-position', '--as-component', '--verify', '--resize-probe=180',
    '--collection=Brand', '--preset=desktop', '--icons=icons', '--manifest=links.json',
    '--approve-fallback=font.named-faces,root', '--allow-free-layout=root.free',
  ];
  const auto = semanticCompoundRenderRequestFromArgv(autoArgv);
  assert.deepEqual(auto.layout, { direction: 'col', gap: 0 });
  assert.deepEqual(auto.placement, { smart: false, x: 10, y: 20 });
  assert.deepEqual(auto.stages, {
    componentConversion: true, resizeProbe: 180, verification: true, verificationDirectory: null,
  });
  assert.deepEqual(auto.assets, {
    localPaths: ['assets/photo.png'], remoteCount: 1, embeddedCount: 0,
  });
  assert.deepEqual(
    semanticCompoundRenderRequestFromArgv(semanticCompoundRenderArgvFromRequest(auto)),
    auto,
  );

  const explicit = semanticCompoundRenderRequestFromArgv([
    'render-batch', JSON.stringify(auto.roots), ...autoArgv.slice(2),
  ]);
  assert.equal(explicit.source, 'explicit-batch');
  assert.deepEqual(explicit.roots, auto.roots);
  assert.deepEqual(explicit.layout, auto.layout);
  assert.deepEqual(explicit.placement, auto.placement);
  assert.deepEqual(explicit.stages, auto.stages);
  assert.deepEqual(explicit.assets, auto.assets);

  const wrapperOptOut = '<Frame flex="row"><Frame name="Card 1"/><Frame name="Card 2"/></Frame>';
  assert.deepEqual(semanticRenderArgvRoute(['render', wrapperOptOut, '--keep-wrapper']), {
    kind: 'simple', reason: null,
  });
  for (const malformed of [
    ['render-batch', '[]'],
    ['render-batch', '{}'],
    ['render-batch', '["<Frame/>"]', '--direction=diagonal'],
    ['render-batch', '["<Frame/>"]', '--gap=-1'],
    ['render-batch', '["<Frame/>"]', '--verify', '--verify'],
    ['render-batch', '["<Frame/>"]', '--verification-output-dir=/tmp/figma-bridge-verify-test-only'],
    ['render', SIMPLE_JSX, '--gap=20'],
  ]) {
    assert.equal(acceptsSemanticRenderArgv(malformed), false, malformed.join(' '));
    assert.equal(planFigmaCommand(malformed).allowed, false, malformed.join(' '));
  }
});

test('compound assets and verification are explicit Command Plan effects', (t) => {
  const { root, io } = workspace(t);
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'icons'));
  writeFileSync(join(root, 'assets', 'photo.png'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, 'icons', 'check.svg'), '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  writeFileSync(join(root, 'icons', '__proto__.svg'), '<svg viewBox="0 0 1 1"><path d="M1 1"/></svg>');
  const wrapper = '<Frame flex="row"><Frame name="Card 1"><Image src={assets/photo.png}/></Frame><Frame name="Card 2"><Image src="https://images.example/card.png"/></Frame></Frame>';
  const argv = ['render', wrapper, '--icons=icons', '--verify'];
  const options = {
    workspaceDir: root,
    workspaceIO: io,
    fileKey: 'FILE_A',
    verificationArtifactNonce: 'test-render-artifacts-0001',
  };
  const mcp = planFigmaCommand(argv, { ...options, adapter: 'mcp' });
  const cli = planFigmaCommand(argv, { ...options, adapter: 'cli' });
  assert.equal(semanticRenderPlanRoute(mcp), 'compound-command-application');
  assert.deepEqual(mcp.effects, {
    figma: 'write', workspace: 'read', network: 'read', shared: 'write',
  });
  assert.equal(mcp.outputs.length, 2);
  assert.deepEqual(mcp.outputs.map((output) => output.path.split('/').at(-1)), [
    'root-001.png', 'root-002.png',
  ]);
  assert.ok(mcp.outputs.every((output) => output.scope === 'private-temporary'));
  assert.match(mcp.argv.find((arg) => arg.startsWith('--verification-output-dir=')),
    /figma-bridge-verify-test-render-artifacts-0001$/);
  const { adapter: mcpAdapter, ...mcpPlan } = mcp;
  const { adapter: cliAdapter, ...cliPlan } = cli;
  assert.equal(mcpAdapter, 'mcp');
  assert.equal(cliAdapter, 'cli');
  assert.deepEqual(cliPlan, mcpPlan);
  const replanned = planFigmaCommand(mcp.argv, {
    ...options, adapter: 'mcp', verificationArtifactNonce: 'ignored-because-directory-is-planned',
  });
  assert.deepEqual(replanned.outputs, mcp.outputs, 'process Adapters retain the exact planned artifacts');
  const prepared = prepareCompoundSemanticRenderPlan(mcp, { workspaceIO: io });
  assert.equal(prepared.preparedAssets.localImages, 1);
  assert.equal(prepared.preparedAssets.remoteImages, 1);
  assert.equal(prepared.preparedAssets.iconDirectory, 1);
  assert.match(prepared.jsxRoots[0], /src="imgref:img0"/);
  assert.doesNotMatch(prepared.jsxRoots[0], /assets\/photo\.png/);
  assert.equal(Object.getPrototypeOf(prepared.client.customIcons), null);
  assert.equal(Object.hasOwn(prepared.client.customIcons, '__proto__'), true);
});

test('DOM capture compatibility retains the exact Plan-owned verification artifact across process re-planning', () => {
  const argv = ['render', '--dom-capture', 'screen.json', '--verify'];
  const options = {
    workspaceDir: '/work',
    adapter: 'mcp',
    verificationArtifactNonce: 'dom-capture-verification-0001',
  };
  const plan = planFigmaCommand(argv, options);
  assert.equal(semanticRenderPlanRoute(plan), 'commander-compatibility');
  assert.equal(plan.outputs.length, 1);
  assert.equal(plan.outputs[0].scope, 'private-temporary');
  assert.ok(plan.argv.some((arg) => arg.startsWith('--verification-output-dir=')));
  const replanned = planFigmaCommand(plan.argv, {
    ...options,
    adapter: 'cli',
    verificationArtifactNonce: 'must-not-replace-planned-directory',
  });
  assert.deepEqual(replanned.outputs, plan.outputs);
  assert.deepEqual(replanned.argv, plan.argv);
});

test('CLI and MCP use one authentic canonical Semantic Render Command Plan', (t) => {
  const { root, io } = workspace(t);
  const payloadUrl = 'https://www.figma.com/design/PAYLOADPLACEHOLDERKEY/FILE_NAME?node-id=9-9';
  const argv = [
    'render', '--allow-free-layout', 'root.free',
    `<Frame name="${payloadUrl}" flex="col"><Text>Hello</Text></Frame>`,
    '--collection', 'Brand', '--keep-wrapper',
  ];
  const options = { workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A' };
  const mcp = planFigmaCommand(argv, { ...options, adapter: 'mcp' });
  const cli = planFigmaCommand(argv, { ...options, adapter: 'cli' });

  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.equal(semanticRenderPlanRoute(mcp), 'command-application');
  assert.equal(semanticRenderPlanRoute(cli), 'command-application');
  assert.equal(mcp.target.fileKey, 'FILE_A');
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.deepEqual(cli.audit, mcp.audit);
  assert.deepEqual(mcp.execution.okExitCodes, [0, 1]);
  assert.deepEqual(mcp.argv, [
    'render', argv[3], '--keep-wrapper', '--collection=Brand',
    `--manifest=${join(root, 'figma-bridge.json')}`, '--allow-free-layout=root.free',
  ]);
  assert.equal(mcp.argv.includes(payloadUrl), false, 'a JSX payload must not become target argv');

  const implicit = planFigmaCommand(['render', `<Frame name="${payloadUrl}"/>`], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io,
  });
  assert.equal(implicit.target.fileKey, null, 'a JSX payload URL must not retarget the write');
  assert.equal(implicit.target.source, 'implicit-single-window');
  assert.throws(() => semanticRenderPlanRoute({ ...mcp }), /requires a Command Plan/);

  const terminated = planFigmaCommand(['render', '--', SIMPLE_JSX], options);
  assert.equal(terminated.allowed, true);
  assert.equal(semanticRenderPlanRoute(terminated), 'command-application');
  assert.equal(terminated.argv.includes('--'), false, 'ordinary JSX needs no canonical delimiter');

  const literalHelp = planFigmaCommand(['render', '--', '--help'], options);
  assert.equal(literalHelp.allowed, true);
  assert.equal(literalHelp.id, 'render');
  assert.equal(literalHelp.effects.figma, 'write');
  assert.equal(literalHelp.target.kind, 'plugin-file');
  assert.deepEqual(literalHelp.argv.slice(-2), ['--', '--help']);

  const terminatedImage = planFigmaCommand([
    'render', '--', '<Frame><Image src="photo.png"/></Frame>',
  ], options);
  assert.equal(terminatedImage.allowed, true);
  assert.deepEqual(semanticRenderArgvRoute([...terminatedImage.argv]), {
    kind: 'compatibility', reason: 'image-resolution',
  });
  assert.ok(terminatedImage.argv.indexOf('--manifest') < terminatedImage.argv.indexOf('--'));
});

test('compound native rendering dispatches one journaled batch and returns one bounded Outcome', async (t) => {
  const roots = [
    '<Frame name="Card 1"><Text>One</Text></Frame>',
    '<Frame name="Card 2"><Text>Two</Text></Frame>',
  ];
  const { plan, io } = compoundPlan(t, ['render-batch', JSON.stringify(roots), '--gap=0', '--direction=col']);
  let nativeCalls = 0;
  let evalCalls = 0;
  const outcome = await executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async (plans, options) => {
      nativeCalls++;
      assert.equal(plans.length, 2);
      assert.deepEqual(options, { gap: 0, vertical: true, smart: true, x: null, y: null });
      return nativeBatchResult(2);
    },
    evaluate: async () => { evalCalls++; throw new Error('must not evaluate'); },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 0);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.roots.map((root) => root.handle), ['10:20', '11:21']);
  assert.deepEqual(outcome.executor, { kind: 'structured-batch', version: 1 });
  assert.equal(outcome.mutation.outcome, 'completed');
  assert.deepEqual(outcome.stages.map(({ kind, status }) => ({ kind, status })), [
    { kind: 'asset-preparation', status: 'skipped' },
    { kind: 'render', status: 'completed' },
    { kind: 'placement', status: 'completed' },
    { kind: 'structural-gate', status: 'completed' },
    { kind: 'component-conversion', status: 'skipped' },
    { kind: 'resize-probe', status: 'skipped' },
    { kind: 'verification', status: 'skipped' },
  ]);
  assert.equal(semanticRenderOutcomeCode(outcome), 0);
  assert.match(formatSemanticRenderResult(outcome), /2 roots created/);
});

test('compound follow-up stages preserve position, final handles and verification artifacts', async (t) => {
  const roots = ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'];
  const { plan, io } = compoundPlan(t, [
    'render-batch', JSON.stringify(roots), '--gap=0', '--direction=col', '-x10', '-y20',
    '--no-smart-position', '--as-component', '--resize-probe=120', '--verify',
  ]);
  const evaluations = [];
  const written = [];
  const outcome = await executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async (_plans, options) => {
      assert.deepEqual(options, { gap: 0, vertical: true, smart: false, x: 10, y: 20 });
      return nativeBatchResult(2);
    },
    evaluate: async (code) => {
      evaluations.push(code);
      if (code.includes('createComponentFromNode')) {
        return {
          version: 1,
          components: [
            { sourceId: '10:20', id: '30:40', name: 'Card 1' },
            { sourceId: '11:21', id: '31:41', name: 'Card 2' },
          ],
          failed: null,
        };
      }
      const handle = code.includes('30:40') ? '30:40' : '31:41';
      if (code.includes('exportAsync')) {
        return { version: 1, failed: false, id: handle, width: 100, height: 80, base64: 'AA==' };
      }
      return { version: 1, passed: true, root: { id: handle }, summary: {} };
    },
    writeVerification: async ({ handle, base64 }) => {
      assert.equal(base64, 'AA==');
      const path = `/tmp/verify-${handle.replace(':', '-')}.png`;
      written.push(path);
      return path;
    },
  });
  assert.equal(evaluations.length, 5, 'one conversion + two probes + two screenshots');
  assert.deepEqual(outcome.roots.map((root) => root.handle), ['30:40', '31:41']);
  assert.deepEqual(written, ['/tmp/verify-30-40.png', '/tmp/verify-31-41.png']);
  assert.equal(outcome.stages.find((stage) => stage.kind === 'component-conversion').status, 'completed');
  assert.equal(outcome.stages.find((stage) => stage.kind === 'resize-probe').status, 'completed');
  assert.deepEqual(outcome.stages.find((stage) => stage.kind === 'verification').artifacts, written);
});

test('partial component conversion fails nonzero with exact known handles and no retry', async (t) => {
  const roots = ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'];
  const { plan, io } = compoundPlan(t, [
    'render-batch', JSON.stringify(roots), '--as-component',
  ]);
  let nativeCalls = 0;
  let evalCalls = 0;
  await assert.rejects(() => executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => { nativeCalls++; return nativeBatchResult(2); },
    evaluate: async () => {
      evalCalls++;
      return {
        version: 1,
        components: [{ sourceId: '10:20', id: '30:40', name: 'Card 1' }],
        failed: { index: 1 },
      };
    },
  }), (error) => {
    const outcome = error.semanticRenderOutcome;
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(outcome.roots.map((root) => root.handle), ['30:40', '11:21']);
    assert.equal(outcome.mutation.outcome, 'completed');
    assert.deepEqual(outcome.stages.at(-1), {
      kind: 'component-conversion', status: 'failed', attempted: 2,
      completed: 1, failed: 1, handles: ['30:40'], artifacts: [],
    });
    assert.throws(() => semanticRenderOutcomeCode(outcome), /has no accepted process code/);
    return true;
  });
  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 1);
});

test('compound component conversion rejects oversized follow-up evidence without retry', async (t) => {
  const { plan, io } = compoundPlan(t, [
    'render-batch', JSON.stringify(['<Frame name="Card"/>']), '--as-component',
  ]);
  let nativeCalls = 0;
  await assert.rejects(() => executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => { nativeCalls++; return nativeBatchResult(1); },
    evaluate: async () => ({
      version: 1,
      components: [{ sourceId: '10:20', id: '30:40', name: 'x'.repeat(129 * 1024) }],
      failed: null,
    }),
  }), (error) => error.kind === 'plugin-result'
    && error.semanticRenderOutcome?.status === 'failed'
    && error.semanticRenderOutcome?.stages.at(-1).kind === 'component-conversion');
  assert.equal(nativeCalls, 1);
});

test('compound resize findings produce accepted code 1 while malformed batch results fail unknown', async (t) => {
  const roots = ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'];
  const finding = compoundPlan(t, [
    'render-batch', JSON.stringify(roots), '--resize-probe=120',
  ]);
  const outcome = await executeCompoundSemanticRenderPlan(finding.plan, {
    workspaceIO: finding.io,
    renderPlanBatch: async () => nativeBatchResult(2),
    evaluate: async (code) => ({
      version: 1, passed: !code.includes('10:20'),
      root: { id: code.includes('10:20') ? '10:20' : '11:21' }, summary: {},
    }),
  });
  assert.equal(outcome.status, 'completed-with-findings');
  assert.equal(outcome.stages.find((stage) => stage.kind === 'resize-probe').status, 'completed-with-findings');
  assert.equal(semanticRenderOutcomeCode(outcome), 1);

  const malformed = compoundPlan(t, ['render-batch', JSON.stringify(roots)]);
  let evalCalls = 0;
  await assert.rejects(() => executeCompoundSemanticRenderPlan(malformed.plan, {
    workspaceIO: malformed.io,
    renderPlanBatch: async () => nativeBatchResult(1),
    evaluate: async () => { evalCalls++; return []; },
  }), (error) => error.kind === 'plugin-result'
    && error.semanticRenderOutcome?.status === 'failed'
    && error.semanticRenderOutcome?.roots.length === 0
    && error.semanticRenderOutcome?.stages.at(-1).kind === 'render');
  assert.equal(evalCalls, 0, 'a malformed post-dispatch batch must never redispatch');
});

test('compound structural findings are an explicit accepted stage', async (t) => {
  const roots = ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'];
  const { plan, io } = compoundPlan(t, ['render-batch', JSON.stringify(roots)]);
  const raw = nativeBatchResult(2);
  raw.frames[0].structuralReport = {
    version: 1,
    passed: false,
    summary: {
      nodes: 1, grids: 0, autoLayouts: 0, freeLayouts: 1,
      instances: 0, absoluteNodes: 0,
    },
    mismatchCount: 1,
    mismatches: [{
      path: 'root', fact: 'layout', expected: 'auto-layout', actual: 'free-layout',
    }],
  };
  const outcome = await executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => raw,
    evaluate: async () => [],
  });
  assert.equal(outcome.status, 'completed-with-findings');
  assert.equal(outcome.stages.find((stage) => stage.kind === 'structural-gate').status, 'completed-with-findings');
  assert.equal(semanticRenderOutcomeCode(outcome), 1);
});

test('compound generated compatibility is chosen only from proven pre-dispatch capability failure', async (t) => {
  const roots = ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'];
  const { plan, io } = compoundPlan(t, ['render-batch', JSON.stringify(roots)]);
  let nativeCalls = 0;
  let evalCalls = 0;
  const outcome = await executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => { nativeCalls++; throw redispatchableCapabilityError(); },
    evaluate: async (code) => {
      evalCalls++;
      assert.match(code, /const results = \[\]/);
      return [{ id: '50:60', name: 'Card 1' }, { id: '51:61', name: 'Card 2' }];
    },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 1);
  assert.deepEqual(outcome.executor, { kind: 'generated-eval-batch-compatibility', version: 1 });
  assert.deepEqual(outcome.roots.map((root) => root.handle), ['50:60', '51:61']);
  assert.equal(outcome.stages.find((stage) => stage.kind === 'structural-gate').status, 'skipped');
});

test('the native Semantic Render executor is dispatched exactly once without generated eval', async (t) => {
  const { plan, io } = renderPlan(t);
  let nativeCalls = 0;
  let evalCalls = 0;
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async (structuredPlan) => {
      nativeCalls += 1;
      assert.equal(structuredPlan.kind, 'figma-bridge/semantic-render-plan');
      return nativeResult();
    },
    evaluate: async () => { evalCalls += 1; return { id: '9:9' }; },
  });

  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 0);
  assert.equal(result.schemaVersion, SEMANTIC_RENDER_OUTCOME_SCHEMA);
  assert.equal(result.kind, SEMANTIC_RENDER_OUTCOME_KIND);
  assert.equal(result.status, 'completed');
  assert.equal(result.roots[0].handle, '1:2');
  assert.deepEqual(result.executor, { kind: 'structured', version: 1 });
  assert.equal(semanticRenderOutcomeCode(result), 0);
});

test('generated compatibility dispatch is allowed only before a native write could dispatch', async (t) => {
  const { plan, io } = renderPlan(t);
  let nativeCalls = 0;
  let evalCalls = 0;
  const fallback = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => { nativeCalls += 1; throw redispatchableCapabilityError(); },
    evaluate: async (code) => {
      evalCalls += 1;
      assert.equal(typeof code, 'string');
      assert.match(code, /createFrame/);
      return { id: '2:3', name: 'Compatibility' };
    },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 1);
  assert.deepEqual(fallback.executor, { kind: 'generated-eval-compatibility', version: 1 });

  const denied = [
    { kind: 'plugin-capability', phase: 'plugin-dispatch', outcome: 'unknown-after-dispatch' },
    { kind: 'plugin-timeout', phase: 'plugin-execution', outcome: 'unknown-after-dispatch' },
    { kind: 'plugin-protocol', phase: 'plugin-response', outcome: 'unknown-after-dispatch' },
    {},
  ];
  for (const facts of denied) {
    const error = Object.assign(new Error('native failure'), facts);
    let deniedEvalCalls = 0;
    await assert.rejects(() => executeSemanticRenderPlan(plan, {
      workspaceIO: io,
      renderPlan: async () => { throw error; },
      evaluate: async () => { deniedEvalCalls += 1; return { id: '9:9' }; },
    }), (actual) => actual === error);
    assert.equal(deniedEvalCalls, 0, JSON.stringify(facts));
  }

  let legacyEvalCalls = 0;
  const legacy = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => {
      throw Object.assign(new Error('old daemon supports eval only'), {
        kind: 'plugin-capability', phase: 'request-validation', outcome: 'not-dispatched',
      });
    },
    evaluate: async () => { legacyEvalCalls++; return { id: '4:5', name: 'Legacy daemon' }; },
  });
  assert.equal(legacyEvalCalls, 1);
  assert.deepEqual(legacy.executor, { kind: 'generated-eval-compatibility', version: 1 });
});

test('locally unsupported native plans choose one generated execution before dispatch', async (t) => {
  const { plan, io } = renderPlan(t, ['render', '<Frame filter="brightness(1.2)" />']);
  const prepared = prepareSemanticRenderPlan(plan, { workspaceIO: io });
  assert.equal(prepared.support.supported, false);
  assert.match(prepared.support.problems.join('\n'), /brightness/);

  let nativeCalls = 0;
  let evalCalls = 0;
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => { nativeCalls += 1; return nativeResult(); },
    evaluate: async () => { evalCalls += 1; return { id: '3:4', name: 'Fallback' }; },
  });
  assert.equal(nativeCalls, 0);
  assert.equal(evalCalls, 1);
  assert.deepEqual(result.executor, { kind: 'generated-eval-compatibility', version: 1 });
  assert.match(result.notices.at(-1).text, /Native preflight unsupported/);
});

test('malformed post-dispatch results remain unknown and never redispatch', async (t) => {
  const { plan, io } = renderPlan(t);
  const cyclic = nativeResult();
  cyclic.cyclic = cyclic;
  const maximumStrings = Array.from(
    { length: MAX_SEMANTIC_RENDER_ARRAY_ITEMS },
    (_, index) => `${index}-${'x'.repeat(MAX_SEMANTIC_RENDER_STRING_CODE_POINTS - String(index).length - 1)}`,
  );
  let nested = 'leaf';
  for (let depth = 0; depth < 10; depth++) nested = { nested };
  for (const malformed of [
    null,
    [],
    { id: 'not-a-node', executor: 'structured-v1', structuralReport: nativeResult().structuralReport },
    { id: '1:2', executor: 'generated-eval-compatibility', structuralReport: nativeResult().structuralReport },
    { id: '1:2', executor: 'structured-v1', structuralReport: { passed: true, summary: 'invalid' } },
    { id: '1:2', executor: 'structured-v1', structuralReport: {
      version: 1,
      passed: true,
      summary: nativeResult().structuralReport.summary,
      mismatchCount: 7,
      mismatches: [{ path: 'root', fact: 'layout', expected: 'GRID', actual: 'NONE' }],
    } },
    { id: '1:2', executor: 'structured-v1', structuralReport: {
      version: 1,
      passed: false,
      summary: nativeResult().structuralReport.summary,
      mismatchCount: 1,
      mismatches: [{ path: 'root', fact: 'layout', expected: {}, actual: 'NONE' }],
    } },
    nativeResult({ width: '' }),
    nativeResult({ variableReport: { references: 1 } }),
    nativeResult({ variableReport: {
      references: 1, reused: 0, created: 0, bound: 0, ambiguous: 0, unsupported: 0,
    } }),
    nativeResult({ textStyleReport: {
      references: 1, reused: 1, created: 1, bound: 1,
    } }),
    nativeResult({ fallbackAnnotationReport: {
      requested: 0, applied: 0, deduplicated: 0, unsupported: 9,
    } }),
    nativeResult({ scopeQuestions: [{
      name: {}, collection: 'Brand', resolvedType: 'COLOR',
      status: 'USER_DECISION_REQUIRED', question: 'Choose', allowedScopes: ['ALL_SCOPES'],
    }] }),
    nativeResult({ scopeQuestions: [{
      name: 'Body', collection: 'Brand', resolvedType: 'STRING',
      status: 'USER_DECISION_REQUIRED', question: 'Choose',
    }] }),
    nativeResult({ stack: 'Plugin internals must not cross the Outcome boundary.' }),
    nativeResult({ unresolved: Array.from(
      { length: MAX_SEMANTIC_RENDER_ARRAY_ITEMS + 1 },
      (_, index) => `Brand/Missing-${index}`,
    ) }),
    nativeResult({ name: 'x'.repeat(MAX_SEMANTIC_RENDER_STRING_CODE_POINTS + 1) }),
    nativeResult({ width: 1_000_001 }),
    nativeResult({
      unresolved: maximumStrings,
      createdVariables: maximumStrings,
      createdTextStyles: maximumStrings,
    }),
    nativeResult({ nested }),
    nativeResult({ mutationReport: {
      version: 1, outcome: 'completed', created: 2, removed: 0,
      residueCount: 0, residue: [], residueTruncated: false, future: true,
    } }),
    cyclic,
  ]) {
    let nativeCalls = 0;
    let evalCalls = 0;
    await assert.rejects(() => executeSemanticRenderPlan(plan, {
      workspaceIO: io,
      renderPlan: async () => { nativeCalls += 1; return malformed; },
      evaluate: async () => { evalCalls += 1; return { id: '9:9' }; },
    }), (error) => error.kind === 'plugin-result'
      && error.phase === 'plugin-response'
      && error.outcome === 'unknown-after-dispatch'
      && error.semanticRenderOutcome?.status === 'failed'
      && error.semanticRenderOutcome?.failure?.phase === 'plugin-response'
      && error.semanticRenderOutcome?.failure?.dispatchState === 'unknown');
    assert.equal(nativeCalls, 1);
    assert.equal(evalCalls, 0);
  }
});

test('known rollback residue is carried only as typed failure facts', async (t) => {
  const { plan, io } = renderPlan(t);
  const secret = 'SECRET-JSX-AND-STACK';
  const pluginFailure = Object.assign(new Error(secret), {
    kind: 'execution',
    phase: 'plugin-execution',
    outcome: 'unknown-after-dispatch',
    dispatchState: 'failed',
    mutationReport: {
      version: 1,
      outcome: 'partial-residue',
      created: 3,
      removed: 2,
      residueCount: 1,
      residue: [{ kind: 'image-resource', handle: 'image-hash-1', reason: 'no-removal-api' }],
      residueTruncated: false,
    },
  });

  await assert.rejects(() => executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => { throw pluginFailure; },
    evaluate: async () => { throw new Error('must not run'); },
  }), (error) => {
    assert.equal(error, pluginFailure);
    const outcome = error.semanticRenderOutcome;
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(outcome.roots, []);
    assert.deepEqual(outcome.mutation, pluginFailure.mutationReport);
    assert.deepEqual(outcome.failure, {
      kind: 'execution',
      phase: 'plugin-execution',
      outcome: 'unknown-after-dispatch',
      dispatchState: 'failed',
    });
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(secret));
    assert.throws(() => semanticRenderOutcomeCode(outcome), /has no accepted process code/);
    assert.throws(() => formatSemanticRenderResult(outcome), /cannot format a failed Outcome as success/);
    return true;
  });
});

test('a structural finding preserves the created root, returns code 1 and bounded deterministic output', async (t) => {
  const { plan, io } = renderPlan(t);
  const maximumText = 'x'.repeat(MAX_SEMANTIC_RENDER_STRING_CODE_POINTS);
  const mismatches = Array.from({ length: 20 }, (_, index) => ({
    path: `root.children[${index}]`,
    fact: index === 0 ? maximumText : `layout-${index}`,
    expected: 'AUTO_LAYOUT',
    actual: 'FREE',
  }));
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => nativeResult({
      id: '7:8',
      structuralReport: {
        version: 1,
        passed: false,
        summary: {
          nodes: 31, grids: 0, autoLayouts: 1, freeLayouts: 30,
          instances: 0, absoluteNodes: 0,
        },
        mismatchCount: 30,
        mismatches,
      },
    }),
    evaluate: async () => { throw new Error('must not run'); },
  });

  assert.equal(result.status, 'completed-with-findings');
  assert.equal(result.roots[0].handle, '7:8');
  assert.equal(result.structure.live.mismatches.length, 20);
  assert.equal(result.structure.live.mismatches[0].fact, maximumText);
  assert.equal(semanticRenderOutcomeCode(result), 1);

  const json = semanticRenderOutcomeJson(result);
  const yaml = semanticRenderOutcomeYaml(result);
  assert.deepEqual(JSON.parse(json), result);
  assert.deepEqual(YAML.parse(yaml), result);
  assert.equal(semanticRenderOutcomeJson(result), json);
  assert.equal(semanticRenderOutcomeYaml(result), yaml);

  const rows = semanticRenderResultRows(result);
  assert.equal(rows.filter((row) => row.tone === 'error').length, 6,
    'one bounded audit summary plus five mismatch rows');
  const output = formatSemanticRenderResult(result);
  assert.match(output, /Rendered: 7:8/);
  assert.match(output, /FAIL — 30 mismatch\(es\)/);
  assert.equal((output.match(/layout-/g) || []).length, 4);
  assert.ok(output.length < 12_000);
});

test('formatter preserves actionable variable, scope and overflow guidance', async (t) => {
  const { plan, io } = renderPlan(t);
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => nativeResult({
      unresolved: ['Brand/Missing'],
      overflow: 24,
      scopeQuestions: [{
        name: 'Body', collection: 'Brand', resolvedType: 'STRING',
        status: 'USER_DECISION_REQUIRED', question: 'Limit Body to TEXT_CONTENT?',
        currentScopes: ['ALL_SCOPES'],
        allowedScopes: ['ALL_SCOPES', 'TEXT_CONTENT'],
      }],
    }),
    evaluate: async () => { throw new Error('must not run'); },
  });
  const output = formatSemanticRenderResult(result);
  assert.match(output, /grey placeholders/);
  assert.match(output, /Limit Body to TEXT_CONTENT\?/);
  assert.match(output, /shrink a child or raise the frame height/);
});
