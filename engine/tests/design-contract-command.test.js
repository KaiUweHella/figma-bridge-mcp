import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  designContractArgvFromRequest,
  designContractFileKeyFromArgv,
  designContractPlanRoute,
  designContractRequestFromArgv,
  designContractResultRows,
  executeDesignContract,
  executeDesignContractPlan,
  formatDesignContractAdapterResult,
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

test('Design Contract request Interface is closed and round-trips typed Adapter input', () => {
  const request = {
    action: 'capture', entityId: 'ui.button',
    manifestPath: '/work/figma-bridge.json', contractPath: '/work/contracts/ui.button.json',
    depth: 10, includeHidden: true, geometryTolerance: 0.75,
  };
  const argv = designContractArgvFromRequest(request);
  assert.deepEqual(argv, [
    'contract', 'capture', 'ui.button',
    '--manifest', '/work/figma-bridge.json',
    '--file', '/work/contracts/ui.button.json',
    '--depth', '10', '--include-hidden', '--geometry-tolerance', '0.75',
  ]);
  assert.deepEqual(designContractRequestFromArgv(argv), {
    ...request, depth: '10', geometryTolerance: '0.75',
  });
  assert.deepEqual(designContractArgvFromRequest({
    ...request, depth: 12, includeHidden: false, geometryTolerance: 0.5,
  }), [
    'contract', 'capture', 'ui.button',
    '--manifest', '/work/figma-bridge.json',
    '--file', '/work/contracts/ui.button.json',
  ]);
  const cliDefault = planFigmaCommand(designContractArgvFromRequest({
    action: 'capture', entityId: 'ui.button',
    manifestPath: '/work/figma-bridge.json',
    contractPath: '/work/design-contracts/ui.button.json',
    depth: 12, includeHidden: false, geometryTolerance: 0.5,
  }), { adapter: 'cli', workspaceDir: '/work' });
  const mcpDefault = planFigmaCommand(['contract', 'capture', 'ui.button'], {
    adapter: 'mcp', workspaceDir: '/work',
  });
  assert.deepEqual(cliDefault.argv, mcpDefault.argv);

  for (const malformed of [
    ['contract', 'capture'],
    ['contract', 'capture', 'ui.button', '--future', 'secret'],
    ['contract', 'capture', 'ui.button', '--file'],
    ['contract', 'capture', 'ui.button', 'extra'],
    ['contract', 'check', 'ui.button', '--geometry-tolerance', '1'],
    ['contract', 'check', 'ui.button', '--include-hidden=true'],
  ]) assert.equal(planFigmaCommand(malformed).allowed, false, malformed.join(' '));
});

test('CLI and MCP Contract plans cross one authentic Command Application Seam', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'design-contract-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, 'figma-bridge.json');
  const contractPath = join(dir, 'ui.button.json');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, project: {}, entities: [{
      id: 'ui.button', kind: 'component', figma: { fileKey: 'FILE_A', nodeId: '1:1' },
    }],
  }));
  let stored = '';
  await executeDesignContract({
    action: 'capture', entityId: 'ui.button', manifestPath, contractPath,
  }, {
    captureDesign: async () => capture(),
    writeContract: async (_path, text) => { stored = text; },
  });
  const argv = ['contract', 'check', 'ui.button', '--manifest', manifestPath, '--file', contractPath];
  const mcpPlan = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILE_A' });
  const cliPlan = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILE_A' });
  assert.equal(designContractPlanRoute(mcpPlan), 'command-application');
  assert.equal(designContractPlanRoute(cliPlan), 'command-application');
  assert.equal(designContractPlanRoute(planFigmaCommand(['inspect', '1:1'])), 'not-design-contract');
  assert.throws(() => designContractPlanRoute({ ...mcpPlan }), /requires a Command Plan/);

  const adapters = { captureDesign: async () => capture(), readContract: async () => stored };
  const fromMcp = await executeDesignContractPlan(mcpPlan, adapters);
  const fromCli = await executeDesignContractPlan(cliPlan, adapters);
  assert.deepEqual(fromCli, fromMcp);
  assert.equal(fromCli.check.ok, true);
});

test('Contract Adapter output preserves the established CLI marker and report', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'design-contract-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, 'figma-bridge.json');
  const contractPath = join(dir, 'ui.button.json');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, project: {}, entities: [{
      id: 'ui.button', kind: 'component', figma: { fileKey: 'FILE_A', nodeId: '1:1' },
    }],
  }));
  let stored = '';
  const captured = await executeDesignContract({
    action: 'capture', entityId: 'ui.button', manifestPath, contractPath,
  }, {
    captureDesign: async () => capture(),
    writeContract: async (_path, text) => { stored = text; },
  });
  assert.equal(formatDesignContractAdapterResult(captured), `✓ ${formatDesignContractResult(captured)}`);
  assert.deepEqual(designContractResultRows(captured)[0], {
    marker: '✓', markerTone: 'success', text: formatDesignContractResult(captured),
  });

  const drift = await executeDesignContract({
    action: 'check', entityId: 'ui.button', manifestPath, contractPath,
  }, { captureDesign: async () => capture(140), readContract: async () => stored });
  assert.equal(formatDesignContractAdapterResult(drift), `✗ ${formatDesignContractResult(drift)}`);
});

test('Design Contract Command Application has no console, termination or global argv dependency', () => {
  for (const relative of [
    '../src/application/design-contract-command.js',
    '../src/application/design-contract-request.js',
  ]) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bconsole\s*\./, relative);
    assert.doesNotMatch(source, /\bprocess\s*\.\s*(?:argv|env|exit|exitCode)\b/, relative);
  }
});
