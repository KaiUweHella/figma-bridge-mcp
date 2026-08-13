import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  designLinkFileKeyFromArgv, designLinkRequestFromArgv, executeDesignLink, formatDesignLinkResult,
  inspectDesignEntityCode, setDesignEntityCode,
} from '../src/application/design-link-command.js';

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
    '--manifest', '/work/figma-bridge.json',
  ]), {
    action: 'accept', entityId: 'screen.settings', comparePath: '/tmp/build.jpg', maxDiff: '5',
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
