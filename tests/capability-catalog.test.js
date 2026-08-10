import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listFigmaCapabilities,
  planFigmaCommand,
} from '../src/capability-catalog.js';

test('catalog denies and gates unknown commands with safe defaults', () => {
  const unknown = planFigmaCommand(['future-command', 'anything']);
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.effects.figma, 'write');
  assert.equal(unknown.execution.retry, 'never');
  const names = listFigmaCapabilities().map(({ name }) => name);
  assert.equal(names.includes('connect'), false);
  assert.equal(names.includes('eval'), false);
  assert.equal(names.includes('render'), true);
  assert.equal(planFigmaCommand(['--help']).allowed, true);
  assert.equal(planFigmaCommand(['--help']).target.kind, 'none');
});

test('catalog owns the full read/write matrix including special flag semantics', () => {
  for (const args of [
    ['render', '<Frame/>'], ['combos', '1:2'], ['node', 'delete', '1:2'],
    ['component', 'add-variant', 'Button', 'State=Loading'], ['tokens', 'spacing'],
    ['tokens', 'sync', 'tokens.json', '--apply'], ['motion', 'timeline', '1:2'],
    ['font', 'remember-axes', '1:2', 'wght=357'], ['font', 'forget-axes', '1:2'],
  ]) assert.equal(planFigmaCommand(args).effects.figma, 'write', args.join(' '));

  for (const args of [
    ['export', 'code-spec', '1:2'], ['node', 'tree', '1:2'], ['tokens'],
    ['tokens', 'sync', 'tokens.json'], ['motion', 'inspect', '1:2'],
    ['map', 'storybook', 'http://localhost:6006'], ['render', '--help'],
    ['gradient', 'extract', 'hero.png'], ['font', 'inspect', '1:2'], ['font', 'axes', '1:2'],
  ]) assert.notEqual(planFigmaCommand(args).effects.figma, 'write', args.join(' '));
  assert.equal(planFigmaCommand(['gradient', 'extract', 'hero.png']).target.kind, 'none');
  assert.equal(planFigmaCommand(['gradient', 'extract', 'hero.png', '--apply-to', '1:2']).effects.figma, 'write');
});

test('catalog specializes targeting, retry, timeout and background execution', () => {
  assert.equal(planFigmaCommand(['api', 'setup']).target.kind, 'none');
  assert.equal(planFigmaCommand(['spec', 'Button']).target.kind, 'none');
  assert.equal(planFigmaCommand(['spec', 'Button', '--check', '1:2']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand(['verify-build', '.']).target.kind, 'none');
  assert.equal(planFigmaCommand(['verify-build', '.', '--node', '1:2']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand(['export', 'code-spec', '1:2']).execution.retry, 'safe-read');
  assert.equal(planFigmaCommand(['inspect', '1:2']).execution.retry, 'safe-read');
  assert.equal(planFigmaCommand(['verify', '1:2']).execution.retry, 'safe-read');
  assert.equal(planFigmaCommand(['render', '<Frame/>']).execution.retry, 'never');
  assert.equal(planFigmaCommand(['render', '<Frame/>']).execution.timeout, 'long');
  assert.equal(planFigmaCommand(['export', 'assets', '1:2']).execution.mode, 'tracked-job');
  assert.equal(planFigmaCommand(['export', 'assets', '1:2']).execution.timeout, 'background');
  assert.deepEqual(planFigmaCommand(['history', 'diff', 'latest', 'live']).execution.okExitCodes, [0, 1]);
});

test('catalog prepares every known project-relative path policy', () => {
  const base = '/work/project';
  const argv = (args) => planFigmaCommand(args, { workspaceDir: base }).argv;
  assert.deepEqual(argv(['extract']).slice(-1), ['/work/project/DESIGN.md']);
  assert.deepEqual(argv(['export', 'assets', '1:2']).slice(-2), ['-o', '/work/project/assets']);
  assert.deepEqual(argv(['export', 'node', '1:2', '--output=shot.png']).slice(-1), ['--output=/work/project/shot.png']);
  assert.deepEqual(argv(['map', 'storybook', 'url']).slice(-2), ['-o', '/work/project/figma-map.json']);
  assert.deepEqual(
    argv(['verify-build', '.', '--compare', 'shot.png']),
    ['verify-build', '/work/project', '--compare', '/work/project/shot.png'],
  );
  assert.deepEqual(
    argv(['verify', '1:2', '--save', 'shot.png']),
    ['verify', '1:2', '--save', '/work/project/shot.png'],
  );
  assert.deepEqual(argv(['node', 'set-image', '1:2', 'photo.png']), ['node', 'set-image', '1:2', '/work/project/photo.png']);
  assert.deepEqual(argv(['tokens', 'sync', 'tokens.json', '--lockfile', '.tokens.lock.json']), [
    'tokens', 'sync', '/work/project/tokens.json', '--lockfile', '/work/project/.tokens.lock.json',
  ]);
  assert.deepEqual(argv(['spec', 'Button', '--file=design/DESIGN.md']), ['spec', 'Button', '--file=/work/project/design/DESIGN.md']);
  assert.deepEqual(argv(['motion', 'apply', 'motion.json']), ['motion', 'apply', '/work/project/motion.json']);
  assert.deepEqual(argv(['history', 'diff', 'latest', 'live', '--changelog', 'changes.md']), [
    'history', 'diff', 'latest', 'live', '--changelog', '/work/project/changes.md',
  ]);
  assert.deepEqual(argv(['export', 'dtcg', 'tokens.json']), ['export', 'dtcg', '/work/project/tokens.json']);
  assert.deepEqual(argv(['export', 'dtcg', '12:34']), ['export', 'dtcg', '12:34']);
});

test('catalog reports workspace and shared-state effects independently from Figma effects', () => {
  assert.deepEqual(planFigmaCommand(['spec', 'Button', '--file', 'DESIGN.md'], { workspaceDir: '/work' }).effects, {
    figma: 'none', workspace: 'read', shared: 'none',
  });
  assert.equal(planFigmaCommand(['tokens', 'sync', 'tokens.json'], { workspaceDir: '/work' }).effects.workspace, 'write');
  assert.equal(planFigmaCommand(['history', 'snapshot']).effects.shared, 'write');
  assert.equal(planFigmaCommand(['history', 'list']).effects.shared, 'read');
});

test('background identity and help index are generated by the same catalog', () => {
  const args = ['export', 'assets', '1:2'];
  const options = { workspaceDir: '/work/project', fileKey: 'FILE_A' };
  const a = planFigmaCommand(args, options).execution.jobKey;
  assert.equal(a, planFigmaCommand([...args], options).execution.jobKey);
  assert.notEqual(a, planFigmaCommand(args, { ...options, fileKey: 'FILE_B' }).execution.jobKey);
  assert.equal(planFigmaCommand(['export', 'code-spec', '1:2'], options).execution.jobKey, null);
  const help = listFigmaCapabilities({ formatted: true });
  for (const { name } of listFigmaCapabilities()) assert.match(help, new RegExp(`(^|\\n)${name} — `));
});

test('catalog invariants make unsafe retries and mutable help impossible', () => {
  for (const { name } of listFigmaCapabilities()) {
    const plan = planFigmaCommand([name, '--help']);
    assert.equal(plan.allowed, true, name);
    assert.notEqual(plan.effects.figma, 'write', name);
    if (plan.effects.figma === 'write') assert.equal(plan.execution.retry, 'never', name);
  }
});
