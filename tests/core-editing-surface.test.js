import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listFigmaCapabilities, planFigmaCommand } from '../src/capability-catalog.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const engineEntry = join(repoRoot, 'engine', 'src', 'index.js');

function help(...args) {
  return execFileSync(process.execPath, [engineEntry, ...args, '--help'], {
    encoding: 'utf8',
  });
}

test('core canvas editing commands are discoverable through the real engine CLI', () => {
  const nodeHelp = help('node');
  assert.match(nodeHelp, /\bduplicate\b/, 'node duplicate must be discoverable');
  assert.match(nodeHelp, /\breparent\b/, 'node reparent must be discoverable');

  const componentPropertyHelp = help('component', 'prop');
  assert.match(componentPropertyHelp, /\bset\b/, 'component prop set must be discoverable');

  const gradientHelp = help('gradient');
  assert.match(gradientHelp, /\bapply\b/, 'gradient apply must be discoverable');
});

test('the typed creation surface includes every core Figma Design primitive', () => {
  const createHelp = help('create');
  for (const primitive of ['polygon', 'star', 'vector', 'slice']) {
    assert.match(createHelp, new RegExp(`\\b${primitive}\\b`), `create ${primitive} must be discoverable`);
    assert.equal(planFigmaCommand(['create', primitive, 'Audit']).allowed, true, `create ${primitive} must be Safe-Mode reachable`);
  }
});

test('core structural and instance operations are explicit id-scoped commands', () => {
  const nodeHelp = help('node');
  for (const operation of ['group', 'ungroup', 'boolean', 'flatten']) {
    assert.match(nodeHelp, new RegExp(`\\b${operation}\\b`), `node ${operation} must be discoverable`);
  }

  const componentHelp = help('component');
  for (const operation of ['create', 'instantiate', 'swap', 'detach', 'overrides']) {
    assert.match(componentHelp, new RegExp(`\\b${operation}\\b`), `component ${operation} must be discoverable`);
  }

  for (const args of [
    ['node', 'group', '1:2', '1:3'],
    ['node', 'ungroup', '1:2'],
    ['node', 'boolean', 'union', '1:2', '1:3'],
    ['node', 'flatten', '1:2', '1:3'],
    ['component', 'swap', '1:2', '3:4'],
    ['component', 'create', 'Card'],
    ['component', 'instantiate', '3:4'],
    ['component', 'detach', '1:2'],
    ['component', 'overrides', '1:2', 'reset'],
  ]) {
    const plan = planFigmaCommand(args);
    assert.equal(plan.allowed, true, args.join(' '));
    assert.equal(plan.effects.figma, 'write', args.join(' '));
  }
});

test('document-level creation includes native page dividers', () => {
  assert.match(help('canvas'), /\bpage-divider\b/);
  assert.equal(planFigmaCommand(['canvas', 'page-divider']).effects.figma, 'write');
});

test('direct node editing exposes common Figma panel properties', () => {
  const setHelp = help('node', 'set');
  for (const flag of [
    '--locked', '--rotation', '--blend-mode', '--clip', '--constrain-proportions',
    '--stroke-align', '--stroke-cap', '--stroke-join', '--dash-pattern',
    '--corner-smoothing', '--radii', '--layout-mode', '--item-spacing', '--padding',
  ]) {
    assert.match(setHelp, new RegExp(flag), `${flag} must be directly editable`);
  }
});

test('variable creation advertises current Figma 1.133 EASING and TIMING types', () => {
  const variableHelp = help('var', 'create');
  assert.match(variableHelp, /EASING/);
  assert.match(variableHelp, /TIMING/);
  const tokenHelp = help('tokens', 'add');
  assert.match(tokenHelp, /EASING/);
  assert.match(tokenHelp, /TIMING/);
});

test('create is Safe-Mode reachable and child creation names its parent explicitly', () => {
  const names = listFigmaCapabilities().map(({ name }) => name);
  assert.ok(names.includes('create'), 'create must be exposed by the Capability Catalog');
  assert.equal(planFigmaCommand(['create', 'rect', 'Thumbnail']).effects.figma, 'write');

  for (const primitive of ['frame', 'rect', 'ellipse', 'text', 'line', 'autolayout']) {
    assert.match(help('create', primitive), /--parent <nodeId>/, `${primitive} must accept --parent`);
  }

  for (const blocked of ['image', 'component', 'group']) {
    assert.equal(
      planFigmaCommand(['create', blocked]).allowed,
      false,
      `legacy create ${blocked} must not become a Safe-Mode escape hatch`,
    );
  }
});

test('new editing primitives are write-gated and target the connected plugin file', () => {
  for (const args of [
    ['node', 'duplicate', '1:2'],
    ['node', 'reparent', '1:2', '3:4'],
    ['component', 'prop', 'set', '1:2', 'Type', 'Secondary'],
    ['gradient', 'apply', '1:2', 'linear-gradient(90deg, #fff, #000)', '--field', 'stroke'],
  ]) {
    const plan = planFigmaCommand(args);
    assert.equal(plan.allowed, true, args.join(' '));
    assert.equal(plan.effects.figma, 'write', args.join(' '));
    assert.equal(plan.target.kind, 'plugin-file', args.join(' '));
  }
});

test('blocked legacy create subcommands are rejected before any Figma connection', async () => {
  const { runCli } = await import('../src/engine.js');
  await assert.rejects(
    () => runCli(['create', 'image', 'https://example.invalid/image.png']),
    /Command not allowed: create image/,
  );
});
