import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
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
  semanticRenderImageReferences,
  semanticRenderPolicyFromArgv,
  semanticRenderResourcePolicyFromArgv,
  semanticRenderRequestFromArgv,
} from '../src/application/semantic-render-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';
import { IMAGE_HARD_LIMIT } from '../src/lib/image-file.js';

const SIMPLE_JSX = '<Frame name="Card" flex="col"><Text>Hello</Text></Frame>';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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
    textStyleReport: { references: 0, reused: 0, created: 0, bound: 0, literal: 0 },
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
    placement: { smart: true, x: null, y: null, slide: null },
    collection: 'Brand',
    resourcePolicy: { materializeGenerated: false },
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
  const positioned = semanticRenderRequestFromArgv([
    'render', SIMPLE_JSX, '-x-120.5', '-y240', '--no-smart-position',
  ]);
  assert.deepEqual(positioned.placement, { smart: false, x: -120.5, y: 240, slide: null });
  assert.deepEqual(semanticRenderArgvFromRequest(positioned), [
    'render', SIMPLE_JSX, '-x-120.5', '-y240', '--no-smart-position',
  ]);

  const slideTargeted = semanticRenderRequestFromArgv([
    'render', SIMPLE_JSX, '--slide=12:34',
  ]);
  assert.deepEqual(
    slideTargeted.placement,
    { smart: true, x: null, y: null, slide: '12:34' },
    'one explicit target slide rides on placement',
  );
  assert.deepEqual(semanticRenderArgvFromRequest(slideTargeted), [
    'render', SIMPLE_JSX, '--slide=12:34',
  ]);
  assert.deepEqual(
    semanticRenderArgvRoute(['render', SIMPLE_JSX, '--slide=12:34']),
    { kind: 'simple', reason: null },
    'a slide target stays on the native route instead of falling back',
  );
  assert.equal(
    semanticRenderRequestFromArgv(['render', SIMPLE_JSX, '--slide=node:12:34']).placement.slide,
    '12:34',
    'a node: prefix is canonicalized away',
  );
  // An empty value is refused by the shared bounded-option check before the
  // slide grammar is reached; the grammar owns everything else.
  assert.throws(
    () => semanticRenderRequestFromArgv(['render', SIMPLE_JSX, '--slide=']),
    /--slide must not be empty/,
  );
  for (const bad of ['--slide=label:Cover', '--slide=12-34', '--slide=Cover']) {
    assert.throws(
      () => semanticRenderRequestFromArgv(['render', SIMPLE_JSX, bad]),
      /slide must be a Figma slide node id/,
      bad,
    );
  }

  const materialized = semanticRenderRequestFromArgv([
    'render', SIMPLE_JSX, '--materialize-resources',
  ]);
  assert.deepEqual(materialized.resourcePolicy, { materializeGenerated: true });
  assert.deepEqual(semanticRenderArgvFromRequest(materialized), [
    'render', SIMPLE_JSX, '--materialize-resources',
  ]);
  assert.deepEqual(semanticRenderResourcePolicyFromArgv(['render', SIMPLE_JSX]), {
    explicitIntent: 'allowed', generated: 'reuse-or-literal',
  });
  assert.deepEqual(semanticRenderResourcePolicyFromArgv([
    'render', SIMPLE_JSX, '--materialize-resources',
  ]), {
    explicitIntent: 'allowed', generated: 'materialize',
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
      kind: 'compound', reason: 'image-materialization', write: true, target: 'figma',
    },
    ...['https://example.test/a.png', 'assets/a.png'].map((value) => ({
      argv: ['render', `<Frame><Image src={${value}}/></Frame>`],
      kind: 'compound', reason: 'image-materialization', write: true, target: 'figma',
    })),
    ...['imgref:asset-1', 'data:image/png;base64,AA=='].map((value) => ({
      argv: ['render', `<Frame><Image src={${value}}/></Frame>`],
      kind: 'compatibility', reason: 'image-resolution', write: true, target: 'figma',
    })),
    { argv: ['render', '<Frame><Image src={"https://example.test/a.png"}/></Frame>'], kind: 'compound', reason: 'image-materialization', write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '-x', '20'], kind: 'simple', reason: null, write: true, target: 'figma' },
    { argv: ['render', SIMPLE_JSX, '--no-smart-position'], kind: 'simple', reason: null, write: true, target: 'figma' },
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
    { argv: ['render', '--prop-reference', 'Text'], kind: 'compatibility', reason: 'prop-reference', write: false, target: 'none' },
    { argv: ['render', '--help'], kind: 'help', reason: null, write: false, target: 'none' },
  ];

  const { root } = workspace(t);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'photo.png'), PNG_1X1);
  writeFileSync(join(root, 'assets', 'a.png'), PNG_1X1);
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

test('quoted and braced src/image syntax share one embedded content identity', async (t) => {
  const { root, io } = workspace(t);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'photo.png'), PNG_1X1);
  const roots = [
    '<Frame name="Quoted src"><Image src="assets/photo.png" /></Frame>',
    '<Frame name="Bare braced src"><Image src={assets/photo.png} /></Frame>',
    '<Frame name="Single-quoted frame image" image={\'assets/photo.png\'} w="100" h="100" imageScale="fit" />',
    '<Frame name="Double-quoted frame image" image={"assets/photo.png"} w="100" h="100" imageScale="fit" />',
  ];
  const references = semanticRenderImageReferences(
    `<Frame data-image="ignored.png" image="assets/photo.png"><Text>src="ignored.png"</Text>${roots[1]}</Frame>`,
  );
  assert.deepEqual(references.map(({ attribute, value }) => ({ attribute, value })), [
    { attribute: 'image', value: 'assets/photo.png' },
    { attribute: 'src', value: 'assets/photo.png' },
  ]);

  const plan = planFigmaCommand(['render-batch', JSON.stringify(roots)], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
  });
  assert.equal(plan.effects.workspace, 'read');
  const prepared = await prepareCompoundSemanticRenderPlan(plan, { workspaceIO: io });
  assert.deepEqual(prepared.preparedAssets, {
    localImages: 1,
    iconDirectory: 0,
    remoteImages: 0,
    embeddedImages: 0,
    uniqueImageContent: 1,
  });
  assert.ok(prepared.jsxRoots.every((jsx) => /(?:src|image)="imgref:img0"/.test(jsx)));
  const assets = prepared.renderPlans.map((renderPlan) =>
    renderPlan.root.asset || renderPlan.root.children[0]?.asset);
  assert.ok(assets.every((asset) => asset?.kind === 'embedded-raster'));
  assert.equal(new Set(assets.map((asset) => asset.sha256)).size, 1);
  assert.ok(
    prepared.supports.every((support) => support.supported),
    JSON.stringify(prepared.supports),
  );
});

test('invalid local image inputs stop before Figma mutation preparation completes', async (t) => {
  for (const jsx of [
    '<Frame><Image src="" /></Frame>',
    '<Frame><Image src={runtimeImageVariable} /></Frame>',
    '<Frame image="assets/photo.bmp" />',
  ]) {
    assert.throws(
      () => semanticRenderArgvRoute(['render', jsx]),
      /Invalid render command: image reference/i,
      jsx,
    );
  }

  const { root, io } = workspace(t);
  mkdirSync(join(root, 'assets'));
  assert.throws(
    () => planFigmaCommand(['render', '<Frame><Image src={assets/missing.png} /></Frame>'], {
      adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
    }),
    /path is unavailable/i,
  );

  const outside = join(tmpdir(), `fid-07-outside-${process.pid}.png`);
  writeFileSync(outside, PNG_1X1);
  t.after(() => rmSync(outside, { force: true }));
  assert.throws(
    () => planFigmaCommand(['render', `<Frame><Image src="${outside}" /></Frame>`], {
      adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
    }),
    /outside allowed roots/i,
  );

  writeFileSync(join(root, 'assets', 'mismatch.png'), Buffer.from('GIF89a0000'));
  writeFileSync(join(root, 'assets', 'oversized.png'), Buffer.alloc(IMAGE_HARD_LIMIT + 1));
  for (const [file, error] of [
    ['mismatch.png', /extension does not match/i],
    ['oversized.png', /exceeds .* bytes/i],
  ]) {
    const plan = planFigmaCommand([
      'render', `<Frame><Image src={assets/${file}} /></Frame>`,
    ], {
      adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
    });
    await assert.rejects(
      () => prepareCompoundSemanticRenderPlan(plan, { workspaceIO: io }),
      error,
    );
  }
});

test('empty root spellings prepare the same native Semantic Render Plan', (t) => {
  const prepared = ['<Frame/>', '<Frame />', '<Frame></Frame>'].map((jsx) => {
    const { plan, io } = renderPlan(t, ['render', jsx]);
    return prepareSemanticRenderPlan(plan, { workspaceIO: io });
  });
  assert.deepEqual(prepared[1].renderPlan, prepared[0].renderPlan);
  assert.deepEqual(prepared[2].renderPlan, prepared[0].renderPlan);
  assert.deepEqual(prepared.map((entry) => entry.support), [
    { supported: true, problems: [] },
    { supported: true, problems: [] },
    { supported: true, problems: [] },
  ]);
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
    '--approve-flat-repetition=flat-0123456789ab',
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
  assert.deepEqual(auto.approvedFlatRepetitions, ['flat-0123456789ab']);
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
    ['render-batch', '["<Frame/>"]', '--approve-flat-repetition=*'],
    ['render-batch', '["<Frame/>"]', '--approve-flat-repetition=flat-0123456789ab', '--approve-flat-repetition=flat-abcdefabcdef'],
    ['render-batch', '["<Frame/>"]', '--verification-output-dir=/tmp/figma-bridge-verify-test-only'],
    ['render', SIMPLE_JSX, '--gap=20'],
  ]) {
    assert.equal(acceptsSemanticRenderArgv(malformed), false, malformed.join(' '));
    assert.equal(planFigmaCommand(malformed).allowed, false, malformed.join(' '));
  }
});

test('compound assets and verification are explicit Command Plan effects', async (t) => {
  const { root, io } = workspace(t);
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'icons'));
  writeFileSync(join(root, 'assets', 'photo.png'), PNG_1X1);
  writeFileSync(join(root, 'icons', 'check.svg'), '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  writeFileSync(join(root, 'icons', '__proto__.svg'), '<svg viewBox="0 0 1 1"><path d="M1 1"/></svg>');
  const wrapper = '<Frame flex="row"><Frame name="Card 1"><Image src={assets/photo.png}/></Frame><Frame name="Card 2"><Image src="https://images.example/card.png?signed-secret=redacted"/><Image src="https://images.example/card.png?signed-secret=redacted"/></Frame></Frame>';
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
    figma: 'write', editor: 'none', workspace: 'read', network: 'read', shared: 'write',
  });
  assert.equal(mcp.outputs.length, 2);
  assert.deepEqual(mcp.outputs.map((output) => basename(output.path)), [
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
  let remoteMaterializations = 0;
  const prepared = await prepareCompoundSemanticRenderPlan(mcp, {
    workspaceIO: io,
    materializeRemoteImage: async () => {
      remoteMaterializations++;
      return Object.freeze({
        kind: 'embedded-raster', name: 'card.png', base64: PNG_1X1.toString('base64'),
        width: 1, height: 1,
        sha256: createHash('sha256').update(PNG_1X1).digest('hex'),
        source: Object.freeze({ kind: 'remote-http', label: 'https://images.example/card.png' }),
      });
    },
  });
  assert.equal(prepared.preparedAssets.localImages, 1);
  assert.equal(prepared.preparedAssets.remoteImages, 1);
  assert.equal(prepared.preparedAssets.uniqueImageContent, 1);
  assert.equal(remoteMaterializations, 1, 'an exact remote reference is read only once per command');
  assert.equal(prepared.preparedAssets.iconDirectory, 1);
  assert.match(prepared.jsxRoots[0], /src="imgref:img0"/);
  assert.match(prepared.jsxRoots[1], /src="imgref:img1"/);
  assert.doesNotMatch(prepared.jsxRoots[0], /assets\/photo\.png/);
  assert.deepEqual(prepared.renderPlans.map((item) => item.root.children[0].asset.source), [
    { kind: 'workspace', label: 'photo.png' },
    { kind: 'remote-http', label: 'https://images.example/card.png' },
  ]);
  assert.equal(new Set(prepared.renderPlans.map((item) => item.root.children[0].asset.sha256)).size, 1);
  assert.doesNotMatch(JSON.stringify(prepared.renderPlans), /signed-secret|redacted/);
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
  writeFileSync(join(root, 'photo.png'), PNG_1X1);
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
    kind: 'compound', reason: 'image-materialization',
  });
  assert.ok(terminatedImage.argv.some((arg) => arg.startsWith('--manifest=')));
});

test('CLI and MCP bind the same target-aware Design Entity identities without authored handles', (t) => {
  const { root, io } = workspace(t);
  writeFileSync(join(root, 'figma-bridge.json'), JSON.stringify({
    version: 1,
    entities: [
      { id: 'screen.release-proof', kind: 'screen' },
      {
        id: 'ui.button', kind: 'component', figma: {
          componentKey: 'PUBLISHED_BUTTON', nodeId: '10:20', fileKey: 'FILE_A',
          variant: 'State=Default',
        },
      },
      {
        id: 'ui.icon', kind: 'component', figma: {
          componentKey: 'PUBLISHED_ICON', nodeId: '10:30', fileKey: 'FILE_A',
        },
      },
    ],
  }));
  const jsx = '<Frame entity="screen.release-proof"><Instance entity="ui.button" prop:Icon="ui.icon"/></Frame>';
  const options = { workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A' };
  const mcp = prepareSemanticRenderPlan(
    planFigmaCommand(['render', jsx], { ...options, adapter: 'mcp' }),
    { workspaceIO: io },
  );
  const cli = prepareSemanticRenderPlan(
    planFigmaCommand(['render', jsx], { ...options, adapter: 'cli' }),
    { workspaceIO: io },
  );

  assert.deepEqual(cli.renderPlan.designEntityBindings, mcp.renderPlan.designEntityBindings);
  assert.match(mcp.renderPlan.designEntityBindings.registry.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(mcp.renderPlan.designEntityBindings.targetConstraint, {
    kind: 'file-key', fileKey: 'FILE_A',
  });
  assert.deepEqual(mcp.renderPlan.designEntityBindings.bindings['ui.button'], {
    entityId: 'ui.button', entityKind: 'component', purposes: ['instance'],
    handleKind: 'published-key', handle: 'PUBLISHED_BUTTON',
    localFallback: { handleKind: 'local-node', handle: '10:20', fileKey: 'FILE_A' },
    variantIntents: ['State=Default'],
  });
  assert.deepEqual(mcp.renderPlan.designEntityBindings.bindings['ui.icon'].purposes, ['instance-swap']);
  assert.equal(mcp.renderPlan.root.children[0].source.props.key, undefined);
  assert.equal(mcp.renderPlan.root.children[0].source.props.id, undefined);
  assert.equal(mcp.renderPlan.root.children[0].source.props.variant, 'State=Default');
  assert.equal(mcp.renderPlan.designEntityBindings.bindings['screen.release-proof'].handleKind, 'created-root');

  const prepare = (candidate, fileKey = 'FILE_A') => prepareSemanticRenderPlan(
    planFigmaCommand(['render', candidate], {
      adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey,
    }),
    { workspaceIO: io },
  );
  assert.throws(
    () => prepare('<Frame><Instance entity="ui.button" key="CALLER_KEY"/></Frame>'),
    /conflicting authored key anchor/,
  );
  assert.throws(
    () => prepare('<Frame><Instance entity="ui.missing"/></Frame>'),
    /missing from the Registry projection/,
  );
  assert.throws(
    () => prepare('<Frame><Instance entity="screen.release-proof"/></Frame>'),
    /must resolve to a component entity/,
  );

  writeFileSync(join(root, 'figma-bridge.json'), JSON.stringify({
    version: 1,
    entities: [{
      id: 'ui.local-only', kind: 'component',
      figma: { nodeId: '20:30', fileKey: 'FILE_A' },
    }],
  }));
  assert.throws(
    () => prepare('<Frame><Instance entity="ui.local-only"/></Frame>', 'FILE_B'),
    /belongs to Figma file FILE_A, not the Command target/,
  );
});

test('compound reuse planning resolves component Instances before any screen can dispatch', async (t) => {
  const { root, io } = workspace(t);
  const manifest = join(root, 'figma-bridge.json');
  writeFileSync(manifest, JSON.stringify({
    version: 1,
    entities: [{
      id: 'ui.card', kind: 'component',
      figma: { componentKey: 'PUBLISHED_CARD', nodeId: '10:20', fileKey: 'FILE_A' },
    }],
  }));
  const roots = [
    '<Frame name="First" flex="col"><Instance entity="ui.card" text:Label="One" /></Frame>',
    '<Frame name="Second" flex="col"><Instance entity="ui.card" text:Label="Two" /></Frame>',
  ];
  const plan = planFigmaCommand([
    'render-batch', JSON.stringify(roots), `--manifest=${manifest}`,
  ], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
  });
  const prepared = await prepareCompoundSemanticRenderPlan(plan, { workspaceIO: io });

  assert.deepEqual(prepared.reusePlan.summary, {
    reusedComponents: 1, reusedInstances: 2, approvedFlatRepetitions: 0,
  });
  assert.deepEqual(prepared.reusePlan.components, [{
    entity: 'ui.card', instances: 2, rootIndexes: [0, 1], firstRoot: 0,
  }]);
  assert.ok(prepared.renderPlans.every((renderPlan) => (
    renderPlan.designEntityBindings.bindings['ui.card'].handle === 'PUBLISHED_CARD'
    && renderPlan.root.children[0].source.type === 'instance'
  )));
});

test('rendered-root identity rejects incompatible component conversion before execution', async (t) => {
  const { root, io } = workspace(t);
  writeFileSync(join(root, 'figma-bridge.json'), JSON.stringify({
    version: 1,
    entities: [{ id: 'screen.release-proof', kind: 'screen' }],
  }));
  const plan = planFigmaCommand([
    'render-batch', JSON.stringify([
      '<Frame entity="screen.release-proof" name="Release proof"/>',
    ]), '--as-component',
  ], {
    adapter: 'mcp', workspaceDir: root, workspaceIO: io, fileKey: 'FILE_A',
  });
  await assert.rejects(
    () => prepareCompoundSemanticRenderPlan(plan, { workspaceIO: io }),
    /screen\/frame Design Entity cannot use --as-component/,
  );
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
      assert.deepEqual(options, {
        gap: 0, vertical: true, smart: true, x: null, y: null,
        materializeResources: false,
      });
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
    { kind: 'reuse-preflight', status: 'completed' },
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
  assert.match(formatSemanticRenderResult(outcome), /component reuse: 0 component entities, 0 instances, 0 components created/);
});

test('multi-screen acceptance blocks flat repetition before dispatch and reports an exact approval', async (t) => {
  const card = (label) => `<Frame name="Card ${label}" flex="col" gap={8} p={16} bg="#ffffff" rounded={12} w={200}>`
    + `<Text size={16} weight="bold">${label}</Text><Text size={12}>Supporting copy</Text></Frame>`;
  const roots = [
    `<Frame name="Screen One" flex="col">${card('One')}</Frame>`,
    `<Frame name="Screen Two" flex="col">${card('Two')}</Frame>`,
  ];
  const first = compoundPlan(t, ['render-batch', JSON.stringify(roots)]);
  let findingId;
  await assert.rejects(
    () => prepareCompoundSemanticRenderPlan(first.plan, { workspaceIO: first.io }),
    (error) => {
      findingId = error.message.match(/flat-[0-9a-f]{12}/)?.[0];
      return error.outcome === 'not-dispatched'
        && /replace the copies with <Instance entity=/.test(error.message)
        && Boolean(findingId);
    },
  );

  const approved = compoundPlan(t, [
    'render-batch', JSON.stringify(roots), `--approve-flat-repetition=${findingId}`,
  ]);
  let writes = 0;
  const outcome = await executeCompoundSemanticRenderPlan(approved.plan, {
    workspaceIO: approved.io,
    renderPlanBatch: async (_plans, options) => {
      writes++;
      assert.deepEqual(options, {
        gap: 40, vertical: false, smart: true, x: null, y: null,
        materializeResources: false,
      });
      return nativeBatchResult(2);
    },
  });
  assert.equal(writes, 1);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.reuse.summary, {
    reusedComponents: 0,
    reusedInstances: 0,
    createdComponents: 0,
    approvedFlatRepetitions: 1,
  });
  assert.deepEqual(outcome.reuse.flatRepetitions, [{
    id: findingId, count: 2, rootIndexes: [0, 1], approved: true,
  }]);
  assert.match(formatSemanticRenderResult(outcome), /1 approved flat repetition/);
});

test('compound compatibility reports the exact affected root without disabling the batch', async (t) => {
  const roots = [
    '<Frame filter="brightness(1.2)"/>',
    '<Frame><Text>Still useful</Text></Frame>',
  ];
  const { plan, io } = compoundPlan(t, ['render-batch', JSON.stringify(roots)]);
  let nativeCalls = 0;
  let evalCalls = 0;
  const outcome = await executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => { nativeCalls++; return nativeBatchResult(2); },
    evaluate: async () => {
      evalCalls++;
      return [{ id: '12:20' }, { id: '12:21' }];
    },
  });

  assert.equal(nativeCalls, 0);
  assert.equal(evalCalls, 1);
  assert.equal(outcome.status, 'completed-with-findings');
  assert.deepEqual(outcome.roots.map((root) => root.handle), ['12:20', '12:21']);
  assert.deepEqual(outcome.degradations, [{
    kind: 'compatibility-fallback',
    path: 'root[0]',
    fact: 'CSS filter brightness() is not supported by native Figma effects',
    disposition: 'generated-eval-compatibility',
  }]);
  assert.equal(semanticRenderOutcomeCode(outcome), 1);
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
      assert.deepEqual(options, {
        gap: 0, vertical: true, smart: false, x: 10, y: 20,
        materializeResources: false,
      });
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
        const bytes = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
        bytes.writeUInt32BE(13, 8);
        bytes.write('IHDR', 12, 'ascii');
        bytes.writeUInt32BE(100, 16);
        bytes.writeUInt32BE(80, 20);
        return {
          version: 1, failed: false, id: handle,
          nodeWidth: 101, nodeHeight: 81, requestedScale: 1, appliedScale: 1,
          base64: bytes.toString('base64'),
        };
      }
      return { version: 1, passed: true, root: { id: handle }, summary: {} };
    },
    writeVerification: async ({ handle, bytes, width, height }) => {
      assert.equal(Buffer.isBuffer(bytes), true);
      assert.deepEqual({ width, height }, { width: 100, height: 80 });
      const path = `/tmp/verify-${handle.replace(':', '-')}.png`;
      written.push(path);
      return path;
    },
  });
  assert.equal(evaluations.length, 5, 'one conversion + two probes + two screenshots');
  for (const code of evaluations.filter((entry) => entry.includes('exportAsync'))) {
    assert.match(code, /figmaBridgeStableLayoutSamples >= 2/);
    assert.match(code, /setTimeout\(resolve, 20\)/);
    assert.match(code, /figmaBridgeExportAttempt < 5/);
    assert.match(code, /figmaBridgeCandidatePng\.length > figmaBridgeBestPngBytes/);
  }
  assert.deepEqual(outcome.roots.map((root) => root.handle), ['30:40', '31:41']);
  assert.deepEqual(written, ['/tmp/verify-30-40.png', '/tmp/verify-31-41.png']);
  assert.equal(outcome.stages.find((stage) => stage.kind === 'component-conversion').status, 'completed');
  assert.equal(outcome.reuse.summary.createdComponents, 2);
  assert.equal(outcome.stages.find((stage) => stage.kind === 'resize-probe').status, 'completed');
  const verification = outcome.stages.find((stage) => stage.kind === 'verification');
  assert.deepEqual(verification.artifacts, written);
  assert.deepEqual(verification.verification, written.map((artifact) => ({
    artifact, width: 100, height: 80, pixelWidth: 100, pixelHeight: 80,
    nodeWidth: 101, nodeHeight: 81,
    requestedScale: 1, appliedScale: 1, scale: 1,
  })));
});

test('compound verification rejects malformed PNG evidence before artifact persistence', async (t) => {
  const { plan, io } = compoundPlan(t, [
    'render-batch', '["<Frame name=\\"Card\\"/>"]', '--verify',
  ]);
  let writes = 0;
  await assert.rejects(() => executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => nativeBatchResult(1),
    evaluate: async () => ({
      version: 1, failed: false, id: '10:20',
      nodeWidth: 100, nodeHeight: 80, requestedScale: 1, appliedScale: 1,
      base64: Buffer.alloc(24).toString('base64'),
    }),
    writeVerification: async () => { writes++; return '/tmp/must-not-exist.png'; },
  }), (error) => error.kind === 'plugin-result'
    && /invalid bounded PNG evidence/.test(error.message)
    && error.semanticRenderOutcome?.stages.at(-1).kind === 'verification');
  assert.equal(writes, 0);
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

test('typed compound render never redispatches as eval after a capability failure', async (t) => {
  const roots = ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'];
  const { plan, io } = compoundPlan(t, ['render-batch', JSON.stringify(roots)]);
  let nativeCalls = 0;
  let evalCalls = 0;
  const error = redispatchableCapabilityError();
  await assert.rejects(() => executeCompoundSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlanBatch: async () => { nativeCalls++; throw error; },
    evaluate: async () => { evalCalls++; return []; },
  }), (actual) => actual === error);
  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 0);
  assert.deepEqual(error.semanticRenderOutcome.executor, { kind: 'structured-batch', version: 1 });
});

test('the native Semantic Render executor is dispatched exactly once without generated eval', async (t) => {
  const { plan, io } = renderPlan(t);
  let nativeCalls = 0;
  let evalCalls = 0;
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async (structuredPlan, placement) => {
      nativeCalls += 1;
      assert.equal(structuredPlan.kind, 'figma-bridge/semantic-render-plan');
      assert.deepEqual(placement, {
        smart: true, x: null, y: null, materializeResources: false,
      });
      return nativeResult();
    },
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

test('explicit resource materialization reaches the native executor', async (t) => {
  const { plan, io } = renderPlan(t, [
    'render', SIMPLE_JSX, '--materialize-resources',
  ]);
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async (_structuredPlan, placement) => {
      assert.deepEqual(placement, {
        smart: true, x: null, y: null, materializeResources: true,
      });
      return nativeResult();
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.executor, { kind: 'structured', version: 1 });
});

test('explicit single-root placement stays on the native Command Application', async (t) => {
  const { plan, io } = renderPlan(t, [
    'render', SIMPLE_JSX, '-x-45.5', '-y120', '--no-smart-position',
  ]);
  assert.equal(semanticRenderPlanRoute(plan), 'command-application');
  let nativeCalls = 0;
  let evalCalls = 0;
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async (structuredPlan, placement) => {
      nativeCalls += 1;
      assert.equal(structuredPlan.kind, 'figma-bridge/semantic-render-plan');
      assert.deepEqual(placement, {
        smart: false, x: -45.5, y: 120, materializeResources: false,
      });
      return nativeResult();
    },
    evaluate: async () => { evalCalls += 1; return {}; },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(evalCalls, 0);
  assert.deepEqual(result.executor, { kind: 'structured', version: 1 });
});

test('typed Semantic Render never redispatches as eval, including before native dispatch', async (t) => {
  const { plan, io } = renderPlan(t);
  const denied = [
    { kind: 'plugin-capability', phase: 'plugin-dispatch', outcome: 'not-dispatched' },
    { kind: 'plugin-capability', phase: 'request-validation', outcome: 'not-dispatched' },
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
});

test('locally unsupported native plans choose one generated execution before dispatch', async (t) => {
  const { plan, io } = renderPlan(t, [
    'render', '<Frame filter="brightness(1.2)" p="17" rounded="9"><Text lineHeight="125%">Fallback</Text></Frame>',
    '-x-45', '-y120', '--no-smart-position',
  ]);
  const prepared = prepareSemanticRenderPlan(plan, { workspaceIO: io });
  assert.equal(prepared.support.supported, false);
  assert.match(prepared.support.problems.join('\n'), /brightness/);

  let nativeCalls = 0;
  let evalCalls = 0;
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => { nativeCalls += 1; return nativeResult(); },
    evaluate: async (code) => {
      evalCalls += 1;
      assert.match(code, /const smartX = -45;/);
      assert.match(code, /frame\.y = 120;/);
      assert.match(code, /lineHeight = \{ value: 125, unit: 'PERCENT' \}/);
      assert.match(code, /const __materializeGeneratedVariables = false;/);
      assert.match(code, /const __materializeGeneratedTextStyles = false;/);
      return { id: '3:4', name: 'Fallback' };
    },
  });
  assert.equal(nativeCalls, 0);
  assert.equal(evalCalls, 1);
  assert.equal(result.status, 'completed-with-findings');
  assert.equal(semanticRenderOutcomeCode(result), 1);
  assert.deepEqual(result.executor, { kind: 'generated-eval-compatibility', version: 1 });
  assert.deepEqual(result.degradations, [{
    kind: 'compatibility-fallback',
    path: 'root',
    fact: 'CSS filter brightness() is not supported by native Figma effects',
    disposition: 'generated-eval-compatibility',
  }]);
  assert.match(result.notices.at(-1).text, /Native preflight unsupported/);
});

test('explicit resource materialization reaches the compatibility executor', async (t) => {
  const { plan, io } = renderPlan(t, [
    'render', '<Frame filter="brightness(1.2)" p="18" rounded="10"><Text>Materialized</Text></Frame>',
    '--materialize-resources',
  ]);
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => { throw new Error('must not run'); },
    evaluate: async (code) => {
      assert.match(code, /const __materializeGeneratedVariables = true;/);
      assert.match(code, /const __materializeGeneratedTextStyles = true;/);
      return { id: '3:6', name: 'Materialized' };
    },
  });

  assert.equal(result.status, 'completed-with-findings');
  assert.deepEqual(result.executor, { kind: 'generated-eval-compatibility', version: 1 });
});

test('compatibility preserves image utility while reporting exact unresolved binding loss', async (t) => {
  const { plan, io } = renderPlan(t, [
    'render', '<Frame gap="var:space/missing"><Image /></Frame>',
  ]);
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => { throw new Error('must not run'); },
    evaluate: async () => ({ id: '3:5', unresolved: ['space/missing'] }),
  });

  assert.equal(result.status, 'completed-with-findings');
  assert.equal(result.roots[0].handle, '3:5');
  assert.deepEqual(result.degradations, [{
    kind: 'compatibility-fallback',
    path: 'root.children[0]',
    fact: 'image needs host-materialized embedded bytes',
    disposition: 'generated-eval-compatibility',
  }, {
    kind: 'unresolved-variable',
    path: 'resources.unresolvedVariables',
    fact: 'space/missing',
    disposition: 'unbound',
  }]);
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
      references: 1, reused: 0, created: 0, bound: 0, literal: 0, ambiguous: 0, unsupported: 0,
    } }),
    nativeResult({ textStyleReport: {
      references: 1, reused: 1, created: 1, bound: 1, literal: 0,
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
  assert.equal(result.status, 'completed-with-findings');
  assert.equal(semanticRenderOutcomeCode(result), 1);
  assert.deepEqual(result.degradations, [{
    kind: 'unresolved-variable',
    path: 'resources.unresolvedVariables',
    fact: 'Brand/Missing',
    disposition: 'unbound',
  }]);
  const output = formatSemanticRenderResult(result);
  assert.match(output, /did not retain their requested Variable bindings/);
  assert.match(output, /Limit Body to TEXT_CONTENT\?/);
  assert.match(output, /shrink a child or raise the frame height/);
});

test('bounded Outcome preserves successful unbound generated literal evidence', async (t) => {
  const { plan, io } = renderPlan(t);
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => nativeResult({
      variableReport: {
        references: 4, reused: 0, created: 0, bound: 0,
        literal: 4, ambiguous: 4, unsupported: 0,
      },
    }),
    evaluate: async () => { throw new Error('must not run'); },
  });

  assert.deepEqual(result.resources.variableReport, {
    references: 4, reused: 0, created: 0, bound: 0,
    literal: 4, ambiguous: 4, unsupported: 0,
  });
  assert.equal(result.status, 'completed');
  assert.equal(semanticRenderOutcomeCode(result), 0);
  assert.deepEqual(result.degradations, []);
  assert.match(formatSemanticRenderResult(result),
    /4 generated literal binding candidate\(s\) stayed literal; exact values were preserved/);
  assert.match(formatSemanticRenderResult(result),
    /4 generated binding candidate\(s\) stayed unbound because reuse was ambiguous or incompatible/);
});

test('bounded Outcome preserves intentional literal resource evidence', async (t) => {
  const { plan, io } = renderPlan(t);
  const result = await executeSemanticRenderPlan(plan, {
    workspaceIO: io,
    renderPlan: async () => nativeResult({
      variableReport: {
        references: 4, reused: 0, created: 0, bound: 0,
        literal: 4, ambiguous: 0, unsupported: 0,
      },
      textStyleReport: {
        references: 1, reused: 0, created: 0, bound: 0, literal: 1,
      },
    }),
  });

  assert.equal(result.status, 'completed');
  const output = formatSemanticRenderResult(result);
  assert.match(output, /4 generated literal binding candidate\(s\) stayed literal/);
  assert.match(output, /1 unmatched typography candidate\(s\) stayed literal/);
});
