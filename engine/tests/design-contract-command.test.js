import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  designContractFileKeyFromArgv,
  executeDesignContract,
  formatDesignContractResult,
} from '../src/application/design-contract-command.js';

function capture(width = 120) {
  return {
    schemaVersion: 5,
    completeness: { payloadComplete: true, depthLimited: false },
    result: { name: 'Button', frames: [{ id: '1:1', t: 'COMPONENT', n: 'Button', w: width, h: 40, kids: [] }] },
  };
}

test('Design Contract Command resolves a Registry entity, writes a contract, then gates drift', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'design-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, 'figma-bridge.json');
  const contractPath = join(dir, 'design-contracts', 'ui.button.json');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, project: {}, entities: [{
      id: 'ui.button', kind: 'component',
      figma: { fileKey: 'FILE_A', nodeId: '1:1' },
    }],
  }));

  let stored = '';
  const captured = await executeDesignContract({
    action: 'capture', entityId: 'ui.button', manifestPath, contractPath, depth: 12,
  }, {
    captureDesign: async () => capture(),
    writeContract: async (_path, text) => { stored = text; },
  });
  assert.match(formatDesignContractResult(captured), /Captured Design Contract/);
  assert.equal(JSON.parse(stored).entity.id, 'ui.button');

  const clean = await executeDesignContract({
    action: 'check', entityId: 'ui.button', manifestPath, contractPath, depth: 12,
  }, {
    captureDesign: async () => capture(),
    readContract: async () => stored,
  });
  assert.equal(clean.check.ok, true);

  const drift = await executeDesignContract({
    action: 'check', entityId: 'ui.button', manifestPath, contractPath, depth: 12,
  }, {
    captureDesign: async () => capture(140),
    readContract: async () => stored,
  });
  assert.equal(drift.check.ok, false);
  assert.match(formatDesignContractResult(drift), /canonical drift: 1 change/);
  assert.match(formatDesignContractResult(drift), /root-geometry/);
  assert.equal(designContractFileKeyFromArgv([
    'contract', 'check', 'ui.button', '--manifest', manifestPath,
  ]), 'FILE_A');
});

test('Design Contract Command validates options before contacting Figma', async () => {
  let captureCalls = 0;
  await assert.rejects(
    executeDesignContract({
      action: 'unknown', manifestPath: '/does/not/matter.json', contractPath: '/tmp/contract.json',
    }, { captureDesign: async () => { captureCalls++; } }),
    /Unknown Design Contract action/,
  );
  await assert.rejects(
    executeDesignContract({
      action: 'capture', manifestPath: '/does/not/matter.json', contractPath: '/tmp/contract.json', depth: 31,
    }, { captureDesign: async () => { captureCalls++; } }),
    /depth must be an integer from 0 to 30/,
  );
  assert.equal(captureCalls, 0);
});
