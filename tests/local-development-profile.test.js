import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

test('source preparation creates two self-contained manifest.json import bundles', () => {
  const destination = mkdtempSync(join(tmpdir(), 'figma-bridge-plugin-imports-'));

  try {
    execFileSync(
      process.execPath,
      ['scripts/prepare-plugin-imports.js'],
      {
        cwd: ROOT,
        env: { ...process.env, PLUGIN_IMPORT_ROOT: destination },
      },
    );

    for (const [directory, template] of [
      ['local', 'local-development.json'],
      ['dev-mode', 'dev-mode.json'],
    ]) {
      assert.equal(
        readFileSync(join(destination, directory, 'manifest.json'), 'utf8'),
        readFileSync(join(ROOT, 'plugin', 'manifests', template), 'utf8'),
      );
      for (const file of ['code.js', 'ui.html']) {
        assert.equal(
          readFileSync(join(destination, directory, file), 'utf8'),
          readFileSync(join(ROOT, 'plugin', file), 'utf8'),
        );
      }
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test('local-development plugin install is separately named and pinned to :3460', () => {
  const home = mkdtempSync(join(tmpdir(), 'figma-bridge-local-profile-'));
  const installDir = join(home, 'checkout', 'plugin', 'local');
  const script = `
    const { installPluginFiles } = await import('./engine/src/commands/setup.js');
    process.stdout.write(installPluginFiles());
  `;

  try {
    const manifestPath = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FIGMA_BRIDGE_PROFILE: 'local-development',
          PLUGIN_LOCAL_INSTALL_DIR: installDir,
        },
        encoding: 'utf8',
      },
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pluginDir = dirname(manifestPath);
    const ui = readFileSync(join(pluginDir, 'ui.html'), 'utf8');
    const code = readFileSync(join(pluginDir, 'code.js'), 'utf8');

    assert.equal(manifest.name, 'Figma Bridge Local Development');
    assert.equal(manifest.id, 'figma-bridge-mcp-local-development');
    assert.deepEqual(manifest.networkAccess.allowedDomains, [
      'ws://localhost:3460',
      'http://localhost:3460',
    ]);
    assert.deepEqual(manifest.networkAccess.devAllowedDomains, [
      'ws://localhost:3460',
      'http://localhost:3460',
    ]);
    assert.match(ui, /const PORTS = \[3456, 3457, 3458, 3459, 3460\];/);
    assert.match(code, /figma\.pluginId === LOCAL_DEVELOPMENT_PLUGIN_ID/);
    assert.equal(manifestPath, join(installDir, 'manifest.json'));
    assert.match(
      readFileSync(join(ROOT, '.gitignore'), 'utf8'),
      /^plugin\/local\/$/m,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('released plugin install keeps the stable identity and full daemon port range', () => {
  const home = mkdtempSync(join(tmpdir(), 'figma-bridge-release-profile-'));
  const installDir = join(home, 'installed-plugin');
  const script = `
    const { installPluginFiles } = await import('./engine/src/commands/setup.js');
    process.stdout.write(installPluginFiles());
  `;

  try {
    const manifestPath = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FIGMA_BRIDGE_PROFILE: '',
          PLUGIN_INSTALL_DIR: installDir,
        },
        encoding: 'utf8',
      },
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const devModeDir = join(installDir, 'dev-mode');
    const devModeManifest = JSON.parse(
      readFileSync(join(devModeDir, 'manifest.json'), 'utf8'),
    );

    assert.equal(manifestPath, join(installDir, 'manifest.json'));
    assert.equal(manifest.name, 'Figma Bridge');
    assert.equal(manifest.id, 'figma-bridge-mcp');
    assert.deepEqual(manifest.editorType, ['figma', 'figjam', 'slides']);
    assert.equal(devModeManifest.name, 'Figma Bridge Dev Mode');
    assert.equal(devModeManifest.id, 'figma-bridge-mcp-dev');
    assert.deepEqual(devModeManifest.editorType, ['dev']);
    assert.deepEqual(devModeManifest.capabilities, ['inspect']);
    assert.ok(existsSync(join(devModeDir, 'code.js')));
    assert.ok(existsSync(join(devModeDir, 'ui.html')));
    for (const port of [3456, 3457, 3458, 3459, 3460]) {
      assert.ok(manifest.networkAccess.allowedDomains.includes(`ws://localhost:${port}`));
      assert.ok(manifest.networkAccess.allowedDomains.includes(`http://localhost:${port}`));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('released plugin copy failure never falls back to the local-development identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'figma-bridge-release-fallback-'));
  const blockedInstallPath = join(home, 'not-a-directory');
  writeFileSync(blockedInstallPath, 'force mkdirSync to fail');
  const script = `
    const { installPluginFiles } = await import('./engine/src/commands/setup.js');
    process.stdout.write(installPluginFiles());
  `;

  try {
    const manifestPath = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FIGMA_BRIDGE_PROFILE: '',
          PLUGIN_INSTALL_DIR: blockedInstallPath,
        },
        encoding: 'utf8',
      },
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    assert.match(manifestPath, /plugin\/manifest\.json$/);
    assert.equal(manifest.name, 'Figma Bridge');
    assert.equal(manifest.id, 'figma-bridge-mcp');
    assert.notEqual(manifest.id, 'figma-bridge-mcp-local-development');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
