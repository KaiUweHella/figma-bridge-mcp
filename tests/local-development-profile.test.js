import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

test('local-development plugin install is separately named and pinned to :3460', () => {
  const home = mkdtempSync(join(tmpdir(), 'figma-bridge-local-profile-'));
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
    assert.match(manifestPath, /figma-bridge-mcp\/plugin\/manifest\.json$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
