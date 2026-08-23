import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSemanticRenderPlan,
  formatSemanticRenderResult,
  prepareSemanticRenderPlan,
  semanticRenderOutcomeCode,
  semanticRenderPlanRoute,
  semanticRenderResultRows,
} from '../src/application/semantic-render-command.js';
import {
  acceptsSemanticRenderArgv,
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
      mismatches: [],
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

test('simple and named compatibility Render modes remain explicitly reachable', (t) => {
  const cases = [
    { argv: ['render', SIMPLE_JSX], kind: 'simple', reason: null, write: true, target: 'figma' },
    {
      argv: ['render', '<Frame flex="row"><Frame name="Card 1"/><Frame name="Card 2"/></Frame>'],
      kind: 'compatibility', reason: 'auto-split', write: true, target: 'figma',
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
    { argv: ['render', SIMPLE_JSX, '--verify'], kind: 'compatibility', reason: 'verification-output', write: true, target: 'figma' },
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
        : expected.kind === 'help' ? 'not-render' : 'commander-compatibility',
      expected.argv.join(' '),
    );
  }
});

test('render-batch remains an explicit writing compatibility command', (t) => {
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
  assert.equal(semanticRenderPlanRoute(plan), 'not-render');
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
  assert.equal(result.id, '1:2');
  assert.equal(result.executor, 'structured-v1');
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
  assert.equal(fallback.executor, 'generated-eval-compatibility');

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
  assert.equal(legacy.executor, 'generated-eval-compatibility');
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
  assert.equal(result.executor, 'generated-eval-compatibility');
  assert.match(result.warnings.at(-1).text, /Native preflight unsupported/);
});

test('malformed post-dispatch results remain unknown and never redispatch', async (t) => {
  const { plan, io } = renderPlan(t);
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
  ]) {
    let nativeCalls = 0;
    let evalCalls = 0;
    await assert.rejects(() => executeSemanticRenderPlan(plan, {
      workspaceIO: io,
      renderPlan: async () => { nativeCalls += 1; return malformed; },
      evaluate: async () => { evalCalls += 1; return { id: '9:9' }; },
    }), (error) => error.kind === 'plugin-result'
      && error.phase === 'plugin-response'
      && error.outcome === 'unknown-after-dispatch');
    assert.equal(nativeCalls, 1);
    assert.equal(evalCalls, 0);
  }
});

test('a structural finding preserves the created root, returns code 1 and bounds evidence output', async (t) => {
  const { plan, io } = renderPlan(t);
  const oversized = 'x'.repeat(5_000);
  const mismatches = Array.from({ length: 30 }, (_, index) => ({
    path: `root.children[${index}].${oversized}`,
    fact: `layout-${index}-${oversized}`,
    expected: `expected-${oversized}`,
    actual: `actual-${oversized}`,
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

  assert.equal(result.id, '7:8');
  assert.equal(result.structuralReport.mismatches.length, 20);
  assert.ok(result.structuralReport.mismatches.every((finding) =>
    Object.values(finding).every((value) => Array.from(value).length <= 513)));
  assert.equal(semanticRenderOutcomeCode(result), 1);

  const rows = semanticRenderResultRows(result);
  assert.equal(rows.filter((row) => row.tone === 'error').length, 6,
    'one bounded audit summary plus five mismatch rows');
  const output = formatSemanticRenderResult(result);
  assert.match(output, /Rendered: 7:8/);
  assert.match(output, /FAIL — 30 mismatch\(es\)/);
  assert.equal((output.match(/layout-/g) || []).length, 5);
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
