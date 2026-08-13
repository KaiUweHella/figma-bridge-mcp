import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESIGN_ENTITY_PLUGIN_DATA_KEY,
  DESIGN_LINK_REGISTRY_FILE,
  adaptLegacyFigmaMap,
  componentLinksFromRegistry,
  emptyDesignLinkRegistry,
  normalizeRepositoryPath,
  parseDesignEntityPluginData,
  parseDesignLinkRegistry,
  readDesignLinkRegistry,
  resolveDesignEntity,
  serializeDesignEntityPluginData,
  upsertDesignEntity,
  writeDesignLinkRegistry,
} from '../src/lib/design-link-registry.js';

test('Design Link Registry upserts one entity and resolves every durable handle', () => {
  const registry = upsertDesignEntity(emptyDesignLinkRegistry({ name: 'app' }), {
    id: 'ui.button',
    kind: 'component',
    code: { path: 'src/Button.tsx', export: 'Button' },
    storybook: { storyId: 'components-button--primary' },
    figma: { fileKey: 'FILE', nodeId: '1:2', componentKey: 'SET_KEY' },
  });
  assert.equal(resolveDesignEntity(registry, { id: 'ui.button' }).code.export, 'Button');
  assert.equal(resolveDesignEntity(registry, { componentKey: 'SET_KEY' }).id, 'ui.button');
  assert.equal(resolveDesignEntity(registry, { fileKey: 'FILE', nodeId: '1:2' }).id, 'ui.button');
  assert.equal(resolveDesignEntity(registry, { storyId: 'components-button--primary' }).id, 'ui.button');
  assert.deepEqual(componentLinksFromRegistry(registry)['ui.button'], {
    entityId: 'ui.button', key: 'SET_KEY', id: '1:2', fileKey: 'FILE',
  });
});

test('Design Link Registry refuses duplicate ids and conflicting Figma handles', () => {
  assert.throws(() => parseDesignLinkRegistry(JSON.stringify({
    version: 1, entities: [
      { id: 'ui.button', kind: 'component' },
      { id: 'ui.button', kind: 'component' },
    ],
  })), /Duplicate Design Entity id/);

  const first = upsertDesignEntity(emptyDesignLinkRegistry(), {
    id: 'ui.button', kind: 'component', figma: { componentKey: 'SAME' },
  });
  assert.throws(() => upsertDesignEntity(first, {
    id: 'ui.card', kind: 'component', figma: { componentKey: 'SAME' },
  }), /Conflicting componentKey link/);
});

test('legacy figma-map.json is a read adapter and explicit entities win conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-legacy-'));
  writeFileSync(join(dir, 'figma-map.json'), JSON.stringify({
    mappings: [{
      figmaName: 'Button', figmaKey: 'KEY', figmaNodeId: '1:2',
      storyId: 'components-button--primary', storyTitle: 'Components/Button',
      importPath: './src/Button.stories.tsx',
    }],
  }));
  const adapted = adaptLegacyFigmaMap(JSON.parse(readFileSync(join(dir, 'figma-map.json'))));
  assert.equal(adapted.length, 1);
  assert.equal(adapted[0].legacy, true);
  assert.equal(adapted[0].code.path, 'src/Button.stories.tsx');

  writeDesignLinkRegistry(join(dir, DESIGN_LINK_REGISTRY_FILE), upsertDesignEntity(emptyDesignLinkRegistry(), {
    id: 'ui.button', kind: 'component', figma: { componentKey: 'KEY' },
    code: { path: 'src/Button.tsx', export: 'Button' },
  }));
  const loaded = readDesignLinkRegistry(dir);
  assert.equal(loaded.explicit, true);
  assert.equal(loaded.registry.entities.length, 1, 'conflicting legacy row is not a second source of truth');
  assert.equal(resolveDesignEntity(loaded.registry, { componentKey: 'KEY' }).id, 'ui.button');
});

test('repository adapter writes atomically and keeps source paths portable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-link-write-'));
  const source = join(dir, 'src', 'Screen.tsx');
  assert.equal(normalizeRepositoryPath(source, dir), 'src/Screen.tsx');
  assert.throws(() => normalizeRepositoryPath('../outside.tsx', dir), /inside the project/);

  const path = writeDesignLinkRegistry(join(dir, DESIGN_LINK_REGISTRY_FILE), upsertDesignEntity(
    emptyDesignLinkRegistry(),
    { id: 'screen.settings', kind: 'screen', code: { path: 'src/Screen.tsx' } },
  ));
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.entities[0].id, 'screen.settings');
});

test('minimal Figma plugin data roundtrips and contains no code path', () => {
  assert.equal(DESIGN_ENTITY_PLUGIN_DATA_KEY, 'figma-bridge-design-entity');
  const text = serializeDesignEntityPluginData({ id: 'screen.settings', kind: 'screen' });
  assert.deepEqual(parseDesignEntityPluginData(text), {
    version: 1, id: 'screen.settings', kind: 'screen',
  });
  assert.equal(text.includes('src/'), false);
  assert.equal(parseDesignEntityPluginData('not json'), null);
});

test('accepted baselines require both fingerprints and an ISO timestamp', () => {
  const valid = upsertDesignEntity(emptyDesignLinkRegistry(), {
    id: 'ui.button', kind: 'component', baseline: {
      version: 1, acceptedAt: '2026-08-11T10:00:00.000Z',
      code: { hash: 'a'.repeat(64) }, figma: { hash: 'b'.repeat(12) },
      visual: {
        diffPct: 2.4, maxDiff: 5, comparedAt: '2026-08-11T09:59:00.000Z',
        buildHash: 'c'.repeat(64), figmaPngHash: 'd'.repeat(64),
      },
    },
  });
  assert.equal(valid.entities[0].baseline.version, 1);
  assert.equal(valid.entities[0].baseline.visual.diffPct, 2.4);
  assert.throws(() => upsertDesignEntity(emptyDesignLinkRegistry(), {
    id: 'ui.button', kind: 'component', baseline: { version: 1, acceptedAt: 'today' },
  }), /fingerprints are required/);
});
