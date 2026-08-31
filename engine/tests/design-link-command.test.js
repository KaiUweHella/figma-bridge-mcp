import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  designLinkArgvFromRequest, designLinkFileKeyFromArgv, designLinkPlanRoute,
  designLinkRequestFromArgv, designLinkResultRows, executeDesignLink, executeDesignLinkPlan,
  formatDesignLinkResult,
  inspectDesignEntityCode, setDesignEntityCode,
} from '../src/application/design-link-command.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const figmaResult = {
  id: '9:9', name: 'Settings', type: 'FRAME', entityId: 'screen.settings', kind: 'screen',
  fileKey: 'FILE', fileName: 'App', componentKey: null, variantKey: null,
};

test('Design Link Command writes both adapters and inspect resolves the same entity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-command-'));
  const manifestPath = join(dir, 'figma-bridge.json');
  const evaluate = async (code) => {
    if (code.includes('setPluginData')) return figmaResult;
    return {
      ...figmaResult,
      pluginData: JSON.stringify({ version: 1, id: 'screen.settings', kind: 'screen' }),
    };
  };
  const linked = await executeDesignLink({
    action: 'set', nodeId: '9:9', entityId: 'screen.settings', kind: 'screen',
    source: 'src/routes/settings.tsx', exportName: 'SettingsScreen',
    storyId: 'screens-settings--default', manifestPath,
  }, { evaluate });
  assert.equal(linked.entity.id, 'screen.settings');
  const stored = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(stored.project.figmaFileKey, 'FILE');
  assert.equal(stored.entities[0].code.path, 'src/routes/settings.tsx');
  assert.equal(stored.entities[0].figma.nodeId, '9:9');

  const inspected = await executeDesignLink({ action: 'inspect', nodeId: '9:9', manifestPath }, { evaluate });
  assert.equal(inspected.plugin.id, 'screen.settings');
  assert.equal(inspected.entity.code.export, 'SettingsScreen');
});

test('a private nested Registry resolves code from its authorized Workspace root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-link-private-registry-'));
  const manifestPath = join(root, 'docs-local/evidence/figma-bridge.json');
  mkdirSync(join(root, 'docs-local/evidence'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/Settings.tsx'), 'export const Settings = () => null;');
  const io = createWorkspaceIO({ root });
  const rawSnapshot = {
    rootId: '9:9', rootName: 'Settings', rootType: 'FRAME', fileKey: 'FILE', fileName: 'App', page: 'Screens',
    nodes: [{
      id: '9:9', name: 'Settings', type: 'FRAME', path: 'Settings', parentId: null,
      index: 0, x: 0, y: 0, w: 100, h: 100, props: {},
    }],
  };
  const evaluate = async (code) => {
    if (code.includes('setPluginData')) return figmaResult;
    if (code.includes('const root =')) return rawSnapshot;
    return {
      ...figmaResult,
      pluginData: JSON.stringify({ version: 1, id: 'screen.settings', kind: 'screen' }),
    };
  };

  await executeDesignLink({
    action: 'set', nodeId: '9:9', entityId: 'screen.settings', kind: 'screen',
    source: 'src/Settings.tsx', manifestPath,
  }, { evaluate, workspaceIO: io });
  const status = await executeDesignLink({
    action: 'status', entityId: 'screen.settings', manifestPath,
  }, { evaluate, workspaceIO: io });

  assert.equal(status.plan.status, 'untracked');
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).entities[0].code.path, 'src/Settings.tsx');
});

test('Design Link list is repository-only and includes legacy adapter entities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-list-'));
  const manifestPath = join(dir, 'figma-bridge.json');
  await executeDesignLink({
    action: 'set', nodeId: '9:9', entityId: 'screen.settings', kind: 'screen', manifestPath,
  }, { evaluate: async () => figmaResult });
  const listed = await executeDesignLink({ action: 'list', manifestPath });
  assert.equal(listed.entities.length, 1);
  assert.equal(listed.entities[0].id, 'screen.settings');
  const configured = await executeDesignLink({
    action: 'configure', designDoc: 'docs/DESIGN.md', tokens: 'design/tokens.json', manifestPath,
  });
  assert.deepEqual(configured.project, {
    figmaFileKey: 'FILE', figmaFileName: 'App',
    designDoc: 'docs/DESIGN.md', tokens: 'design/tokens.json',
  });
});

test('link set writes only explicit entities, never materializes legacy adapter rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-migrate-'));
  const manifestPath = join(dir, 'figma-bridge.json');
  writeFileSync(join(dir, 'figma-map.json'), JSON.stringify({ mappings: [{
    figmaName: 'Button', figmaKey: 'OLD_KEY', storyId: 'components-button--default',
  }] }));
  await executeDesignLink({
    action: 'set', nodeId: '9:9', entityId: 'screen.settings', kind: 'screen', manifestPath,
  }, { evaluate: async () => figmaResult });
  const stored = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(stored.entities.map((entity) => entity.id), ['screen.settings']);
  assert.equal(stored.entities.some((entity) => entity.legacy), false);
});

test('generated plugin code stores minimal identity and remains valid JavaScript', () => {
  const setCode = setDesignEntityCode({ nodeId: '9:9', entityId: 'screen.settings', kind: 'screen' });
  assert.match(setCode, /figma-bridge-design-entity/);
  assert.match(setCode, /setPluginData/);
  assert.equal(setCode.includes('src/routes'), false);
  assert.doesNotThrow(() => new Function('figma', `return ${setCode}`));

  const inspectCode = inspectDesignEntityCode('9:9');
  assert.match(inspectCode, /getPluginData/);
  assert.doesNotThrow(() => new Function('figma', `return ${inspectCode}`));
});

test('figma_run argv adapter stays thin over the Design Link Command Application', () => {
  assert.deepEqual(designLinkRequestFromArgv([
    'link', 'set', '1:2', 'ui.button', '--source', 'src/Button.tsx',
    '--export=Button', '--manifest', '/work/figma-bridge.json',
  ]), {
    action: 'set', nodeId: '1:2', entityId: 'ui.button', kind: undefined,
    source: 'src/Button.tsx', exportName: 'Button', storyId: undefined,
    manifestPath: '/work/figma-bridge.json',
  });
  assert.deepEqual(designLinkRequestFromArgv([
    'link', 'context', 'ui.button', '--manifest=/work/figma-bridge.json',
  ]), { action: 'context', entityId: 'ui.button', manifestPath: '/work/figma-bridge.json' });
  assert.deepEqual(designLinkRequestFromArgv([
    'link', 'status', '--manifest', '/work/figma-bridge.json', 'ui.button',
  ]), { action: 'status', entityId: 'ui.button', manifestPath: '/work/figma-bridge.json' });
  assert.deepEqual(designLinkRequestFromArgv([
    'link', 'accept', 'screen.settings', '--compare', '/tmp/build.jpg', '--max-diff', '5',
    '--require-render-adapter', 'dom-capture',
    '--manifest', '/work/figma-bridge.json',
  ]), {
    action: 'accept', entityId: 'screen.settings', comparePath: '/tmp/build.jpg', maxDiff: '5',
    requiredRenderAdapter: 'dom-capture',
    manifestPath: '/work/figma-bridge.json',
  });
  assert.deepEqual(designLinkRequestFromArgv([
    'link', 'configure', '--tokens', 'design/tokens.json', '--manifest', '/work/figma-bridge.json',
  ]), {
    action: 'configure', tokens: 'design/tokens.json', designDoc: undefined,
    manifestPath: '/work/figma-bridge.json',
  });
  assert.match(formatDesignLinkResult({
    action: 'list', path: '/work/figma-bridge.json', entities: [{ id: 'ui.button', kind: 'component' }],
  }), /ui\.button  \[component\]/);

  const dir = mkdtempSync(join(tmpdir(), 'design-link-target-'));
  const targetManifest = join(dir, 'figma-bridge.json');
  writeFileSync(targetManifest, JSON.stringify({ version: 1, entities: [{
    id: 'ui.button', kind: 'component', figma: { fileKey: 'FILE_A', nodeId: '1:2' },
  }] }));
  assert.equal(designLinkFileKeyFromArgv([
    'link', 'context', 'ui.button', '--manifest', targetManifest,
  ]), 'FILE_A');
});

test('Design Link request Interface rejects Adapter drift before planning', () => {
  const manifestPath = '/work/figma-bridge.json';
  assert.deepEqual(designLinkArgvFromRequest({
    action: 'set', nodeId: '1:2', entityId: 'ui.button', source: 'src/Button.tsx', manifestPath,
  }), [
    'link', 'set', '1:2', 'ui.button', '--source', 'src/Button.tsx', '--manifest', manifestPath,
  ]);
  assert.deepEqual(designLinkArgvFromRequest({
    action: 'inspect', nodeId: '1:2', manifestPath,
  }), ['link', 'inspect', '1:2', '--manifest', manifestPath]);

  for (const args of [
    ['link', 'inspect', '--future', 'secret'],
    ['link', 'inspect', '--manifest'],
    ['link', 'inspect', '1:2', '3:4'],
    ['link', 'set', '1:2'],
    ['link', 'set', '1:2', 'ui.button', '--kind'],
    ['link', 'list', 'unexpected'],
  ]) {
    assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
    assert.throws(
      () => designLinkRequestFromArgv([...args, '--manifest', manifestPath]),
      /Invalid link|Registry path is required/,
      args.join(' '),
    );
  }
});

test('every accepted Design Link plan crosses the Command Application Seam', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-plan-'));
  const manifestPath = join(dir, 'figma-bridge.json');
  const argv = ['link', 'set', '9:9', 'screen.settings', '--kind', 'screen', '--manifest', manifestPath];
  const mcpPlan = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILE' });
  const cliPlan = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILE' });
  assert.equal(designLinkPlanRoute(mcpPlan), 'command-application');
  assert.equal(designLinkPlanRoute(cliPlan), 'command-application');
  for (const args of [
    ['link', 'list'],
    ['link', 'configure'],
    ['link', 'status', 'screen.settings'],
    ['link', 'accept', 'screen.settings'],
    ['link', 'context', 'screen.settings'],
  ]) assert.equal(designLinkPlanRoute(planFigmaCommand(args)), 'command-application', args.join(' '));
  assert.equal(designLinkPlanRoute(planFigmaCommand(['inspect', '9:9'])), 'not-design-link');
  assert.throws(() => designLinkPlanRoute({ ...mcpPlan }), /requires a Command Plan/);

  const fromMcp = await executeDesignLinkPlan(mcpPlan, { evaluate: async () => figmaResult });
  const fromCli = await executeDesignLinkPlan(cliPlan, { evaluate: async () => figmaResult });
  assert.deepEqual(fromCli, fromMcp);
  const listed = await executeDesignLinkPlan(planFigmaCommand([
    'link', 'list', '--manifest', manifestPath,
  ]), {});
  assert.equal(listed.action, 'list');
  assert.deepEqual(listed.entities.map((entity) => entity.id), ['screen.settings']);
});

test('link set and inspect keep the established CLI text as a shared output contract', () => {
  const entity = {
    id: 'ui.button', kind: 'component',
    code: { path: 'src/Button.tsx', export: 'Button' },
    storybook: { storyId: 'components-button--default' },
    figma: { nodeId: '1:2', componentKey: 'COMPONENT_KEY' },
  };
  const setResult = {
    action: 'set', path: '/work/figma-bridge.json', entity,
    figma: { id: '1:2', name: 'Button' },
  };
  assert.equal(formatDesignLinkResult(setResult), [
    '✓ Linked ui.button to Button (1:2)',
    '  Registry: /work/figma-bridge.json',
    'ui.button  [component]',
    '  code: src/Button.tsx#Button',
    '  story: components-button--default',
    '  figma: 1:2  key COMPONENT_KEY',
  ].join('\n'));
  assert.deepEqual(designLinkResultRows(setResult)[0], {
    tone: 'plain', marker: '✓', markerTone: 'success', text: 'Linked ui.button to Button (1:2)',
  });

  assert.equal(formatDesignLinkResult({
    action: 'inspect', figma: { id: '1:2', name: 'Button' },
    plugin: { id: 'ui.button', kind: 'component' }, entity,
  }), [
    'Button (1:2)',
    '  plugin: ui.button [component]',
    'ui.button  [component]',
    '  code: src/Button.tsx#Button',
    '  story: components-button--default',
    '  figma: 1:2  key COMPONENT_KEY',
  ].join('\n'));
  assert.equal(formatDesignLinkResult({
    action: 'inspect', figma: { id: '1:2', name: 'Button' }, plugin: null, entity: null,
  }), 'Button (1:2)\nNo Design Entity link found.');
});

test('Design Link Command Application has no console, process termination or global argv dependency', () => {
  for (const relative of [
    '../src/application/design-link-command.js',
    '../src/application/design-link-request.js',
  ]) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bconsole\s*\./, relative);
    assert.doesNotMatch(source, /\bprocess\s*\.\s*(?:argv|exit|exitCode)\b/, relative);
  }
});

test('status, accept and context share one report-only Round-trip Planner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-roundtrip-'));
  const manifestPath = join(dir, 'figma-bridge.json');
  writeFileSync(join(dir, 'Settings.tsx'), 'export const SettingsScreen = () => null;');
  writeFileSync(join(dir, 'DESIGN.md'), '# Design');
  writeFileSync(join(dir, 'tokens.json'), '{}');
  const rawSnapshot = {
    rootId: '9:9', rootName: 'Settings', rootType: 'FRAME', fileKey: 'FILE', fileName: 'App', page: 'Screens',
    nodes: [{
      id: '9:9', name: 'Settings', type: 'FRAME', path: 'Settings', parentId: null,
      index: 0, x: 0, y: 0, w: 100, h: 100, props: {},
    }],
  };
  const evaluate = async (code) => {
    if (code.includes('setPluginData')) return figmaResult;
    if (code.includes('const root =')) return rawSnapshot;
    return { ...figmaResult, pluginData: JSON.stringify({ version: 1, id: 'screen.settings', kind: 'screen' }) };
  };
  await executeDesignLink({
    action: 'set', nodeId: '9:9', entityId: 'screen.settings', kind: 'screen',
    source: 'Settings.tsx', exportName: 'SettingsScreen', manifestPath,
  }, { evaluate });

  const before = await executeDesignLink({ action: 'status', entityId: 'screen.settings', manifestPath }, { evaluate });
  assert.equal(before.plan.status, 'untracked');
  await assert.rejects(() => executeDesignLink({
    action: 'accept', entityId: 'screen.settings', manifestPath,
  }, { evaluate }), /requires visual proof/);
  const visual = {
    diffPct: 1.2, maxDiff: 5, comparedAt: '2026-08-11T20:00:00.000Z',
    buildHash: 'a'.repeat(64), figmaPngHash: 'b'.repeat(64),
  };
  const accepted = await executeDesignLink({
    action: 'accept', entityId: 'screen.settings', comparePath: '/tmp/build.png', maxDiff: 5, manifestPath,
  }, { evaluate, verifyVisual: async () => visual });
  assert.equal(accepted.plan.status, 'unchanged');
  assert.equal(accepted.baseline.visual.diffPct, 1.2);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).entities[0].baseline.version, 1);

  writeFileSync(join(dir, 'Settings.tsx'), 'export const SettingsScreen = () => "changed";');
  const after = await executeDesignLink({ action: 'status', entityId: 'screen.settings', manifestPath }, { evaluate });
  assert.equal(after.plan.status, 'code-only');
  const projected = await executeDesignLink({ action: 'context', entityId: 'screen.settings', manifestPath }, { evaluate });
  assert.equal(projected.context.roundTrip.status, 'code-only');
  assert.deepEqual(projected.context.projectFiles, { designDoc: 'DESIGN.md', tokens: 'tokens.json' });
  assert.match(projected.context.nextReads.join('\n'), /Settings\.tsx/);

  await assert.rejects(() => executeDesignLink({
    action: 'accept', entityId: 'screen.settings', manifestPath,
  }, { evaluate: async (code) => code.includes('const root =') ? rawSnapshot : { ...figmaResult, pluginData: '' } }),
  /Figma anchor.*missing/);
});

test('existing UI acceptance fails closed without matching DOM-capture provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-render-provenance-'));
  const manifestPath = join(dir, 'figma-bridge.json');
  writeFileSync(join(dir, 'Settings.tsx'), 'export const SettingsScreen = () => null;');
  const rawSnapshot = {
    rootId: '9:9', rootName: 'Settings', rootType: 'FRAME', fileKey: 'FILE', fileName: 'App', page: 'Screens',
    nodes: [{ id: '9:9', name: 'Settings', type: 'FRAME', path: 'Settings', parentId: null,
      index: 0, x: 0, y: 0, w: 100, h: 100, props: {} }],
  };
  let renderAdapter = '';
  const evaluate = async (code) => {
    if (code.includes('setPluginData')) return figmaResult;
    if (code.includes('const root =')) return rawSnapshot;
    return {
      ...figmaResult,
      pluginData: JSON.stringify({ version: 1, id: 'screen.settings', kind: 'screen' }),
      renderAdapter,
      renderProvenance: renderAdapter === 'dom-capture'
        ? { captureVersion: 2, captureHash: 'a'.repeat(64), viewport: { width: 100, height: 100 } }
        : null,
    };
  };
  await executeDesignLink({
    action: 'set', nodeId: '9:9', entityId: 'screen.settings', kind: 'screen',
    source: 'Settings.tsx', manifestPath,
  }, { evaluate });
  const request = {
    action: 'accept', entityId: 'screen.settings', comparePath: '/tmp/build.png',
    maxDiff: 5, requiredRenderAdapter: 'dom-capture', manifestPath,
  };
  await assert.rejects(
    () => executeDesignLink(request, { evaluate, verifyVisual: async () => ({
      diffPct: 0, maxDiff: 5, comparedAt: '2026-08-26T00:00:00.000Z',
      buildHash: 'b'.repeat(64), figmaPngHash: 'c'.repeat(64),
    }) }),
    /requires render adapter dom-capture.*missing/i,
  );

  renderAdapter = 'jsx';
  await assert.rejects(
    () => executeDesignLink(request, { evaluate, verifyVisual: async () => ({}) }),
    /requires render adapter dom-capture.*found jsx/i,
  );

  renderAdapter = 'dom-capture';
  const accepted = await executeDesignLink(request, { evaluate, verifyVisual: async () => ({
    diffPct: 0, maxDiff: 5, comparedAt: '2026-08-26T00:00:00.000Z',
    buildHash: 'b'.repeat(64), figmaPngHash: 'c'.repeat(64),
  }) });
  assert.deepEqual(accepted.baseline.render, {
    adapter: 'dom-capture',
    provenance: { captureVersion: 2, captureHash: 'a'.repeat(64), viewport: { width: 100, height: 100 } },
  });
});
