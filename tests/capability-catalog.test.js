import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  listFigmaCapabilities,
  planFigmaCommand,
} from '../src/capability-catalog.js';
import {
  FIGMA_URL_TARGET_ROOTS,
  figmaUrlTargetProjectionContract,
  listFigmaUrlTargetActions,
} from '../src/figma-target-projection.js';
import { listFigmaCommandGrammar } from '../src/figma-command-grammar.js';

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
    ['font', 'bind', '1:2', 'fontWeight', 'type/weight'], ['font', 'unbind', '1:2', 'fontWeight'],
    ['history', 'save', 'Release 1'],
    ['style', 'create', 'PAINT', 'Brand'], ['style', 'apply', 'Brand', '1:2', '--field', 'fill'],
    ['style', 'bind-font', 'Body', 'fontSize', '--variable', 'type/size/body'],
    ['var', 'set-value', 'space/md', '12', '--mode', 'Light'], ['col', 'mode-add', 'Theme', 'Dark'],
    ['col', 'extend', 'Theme', 'Market'],
    ['library', 'import-variable', 'KEY'], ['library', 'import-style', 'KEY'],
    ['library', 'import-component', 'KEY'], ['library', 'import-component-set', 'KEY'],
    ['prototype', 'add', '1:2', '--navigate-to', '3:4'], ['measure', 'add', '1:2:right', '3:4:left'],
    ['link', 'set', '1:2', 'ui.button'],
    ['annotate', 'category-add', 'Review', '--color', 'blue'],
    ['shader', 'import', 'shader-1'], ['shader', 'apply', '1:2', 'shader-1', '--field', 'fill'],
    ['layout', 'grid', 'set', '1:2', '--rows', '2'], ['slot', 'create', '1:2', 'Content'],
    ['draw', 'stroke-profile', '1:2', '--preset', 'TAPER'],
    ['slides', 'create', 'Intro'], ['slides', 'delete', '1:2'],
  ]) assert.equal(planFigmaCommand(args).effects.figma, 'write', args.join(' '));

  for (const args of [
    ['export', 'code-spec', '1:2'], ['node', 'tree', '1:2'], ['tokens'],
    ['tokens', 'sync', 'tokens.json'], ['motion', 'inspect', '1:2'],
    ['map', 'storybook', 'http://localhost:6006'], ['render', '--help'],
    ['render', '--print-browser-capture', '.screen'],
    ['render', '<Frame name="Audit" />', '--structural-gate'],
    ['gradient', 'extract', 'hero.png'], ['font', 'inspect', '1:2'], ['font', 'axes', '1:2'],
    ['node', 'css', '1:2'], ['export', 'node-json', '1:2'],
    ['style', 'list'], ['style', 'show', 'Brand'], ['style', 'consumers', 'Brand'],
    ['component', 'prop', 'list', '1:2'],
    ['var', 'show', 'space/md'], ['var', 'resolve', 'space/md', '1:2'], ['col', 'show', 'Theme'],
    ['library', 'collections'], ['library', 'variables', 'Primitives'],
    ['prototype', 'inspect', '1:2'], ['measure', 'list'], ['annotate', 'categories'],
    ['shader', 'list'], ['layout', 'grid', 'inspect', '1:2'], ['slot', 'validate'], ['draw', 'inspect', '1:2'],
    ['export', 'video', '1:2'],
    ['link', 'inspect', '1:2'], ['link', 'list'], ['link', 'status', 'ui.button'],
    ['link', 'accept', 'ui.button'], ['link', 'context', 'ui.button'],
    ['link', 'configure', '--design-doc', 'design/DESIGN.md'],
    ['slides', 'inspect'],
  ]) assert.notEqual(planFigmaCommand(args).effects.figma, 'write', args.join(' '));
  assert.equal(planFigmaCommand(['gradient', 'extract', 'hero.png']).target.kind, 'none');
  assert.equal(planFigmaCommand(['gradient', 'extract', 'hero.png', '--apply-to', '1:2']).effects.figma, 'write');
});

test('nested component property effects follow the canonical action id', () => {
  for (const adapter of ['cli', 'mcp']) {
    const read = planFigmaCommand(['component', 'prop', 'list', '1:2'], { adapter });
    assert.equal(read.id, 'component.prop.list');
    assert.equal(read.effects.figma, 'read');
    assert.equal(read.confirmation, 'none');
    assert.equal(read.execution.retry, 'safe-read');
    assert.equal(read.execution.idempotence, 'read-only');
    assert.equal(read.audit.capability, 'component.prop.list');
    assert.equal(read.audit.operation, 'read');
    assert.equal(read.audit.effects.figma, 'read');

    for (const action of ['add', 'set', 'delete']) {
      const write = planFigmaCommand(['component', 'prop', action, '1:2'], { adapter });
      assert.equal(write.id, `component.prop.${action}`);
      assert.equal(write.effects.figma, 'write');
      assert.equal(write.confirmation, 'configured');
      assert.equal(write.execution.retry, 'never');
      assert.equal(write.audit.operation, 'write');
    }
  }

  const unknown = planFigmaCommand(['component', 'prop', 'future', '1:2']);
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.id, 'unknown');
  assert.equal(unknown.effects.figma, 'write');
  assert.equal(unknown.execution.retry, 'never');
});

test('Style Facts closes one policy-identical CLI/MCP safe read', () => {
  const cli = planFigmaCommand(['style', 'show', 'Type/Body'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['style', 'show', '--', 'Type/Body'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.audit.capability, 'style.show');

  const urlName = planFigmaCommand([
    'style', 'show', 'https://www.figma.com/design/FILEA/Style?node-id=10-2',
  ], { adapter: 'mcp' });
  assert.equal(urlName.allowed, true);
  assert.equal(urlName.target.fileKey, null,
    'a URL-shaped style name is payload, never Figma Target Context');
});

test('Style Catalog closes one bounded policy-identical CLI/MCP safe read', () => {
  const cli = planFigmaCommand(['style', 'list', '--type', 'text', '--limit', '25'], {
    adapter: 'cli',
  });
  const mcp = planFigmaCommand(['style', 'list', '--limit=25', '-tTEXT'], {
    adapter: 'mcp',
  });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.audit.capability, 'style.list');
});

test('Variable Discovery closes policy-identical list and wildcard-find reads', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [['var', 'list', '--json', '--limit', '25'], ['var', 'list', '-l25', '--json'], 'var.list'],
    [['var', 'find', 'space/*', '--limit', '25'], ['var', 'find', '--limit=25', '--', 'space/*'], 'var.find'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.execution.retry, 'safe-read');
    assert.equal(cli.audit.capability, action);
  }
});

test('Variable Create closes one policy-identical non-retrying journaled write', () => {
  const cli = planFigmaCommand([
    'var', 'create', '-cTokens', '-tfloat', '-v12', '--allow-duplicate', 'space/md',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'create', '--collection=Tokens', '--type=FLOAT', '--value=12',
    '--allow-duplicate', '--', 'space/md',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.idempotence, 'unknown');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'var.create');
  for (const argv of [
    ['var', 'create', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FUTURE', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', 'One', 'Two'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Batch Creation closes one policy-identical non-retrying journaled batch', () => {
  const json = '[{"name":"color/accent","value":"#1234"},{"name":"enabled","type":"BOOLEAN","value":true}]';
  const cli = planFigmaCommand([
    'var', 'create-batch', '-cTokens', '-mDark', json,
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'create-batch', '--collection=Tokens', '--mode=Dark', '--', json,
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.idempotence, 'unknown');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'var.create-batch');
  for (const argv of [
    ['var', 'create-batch', '-c', 'Tokens', '[]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","future":true}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x"},{"name":"x"}]'],
    ['var', 'create-batch', '-c', 'Tokens', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Set Value closes one policy-identical non-retrying rollback-owned write', () => {
  const cli = planFigmaCommand([
    'var', 'set-value', '-mMode 1', '-cTokens', 'space/md', '20',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'set-value', '--mode=Mode 1', '--collection=Tokens', '--', 'space/md', '20',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.idempotence, 'unknown');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'var.set-value');
  for (const argv of [
    ['var', 'set-value', 'space/md', '20'],
    ['var', 'set-value', '-m', 'Mode 1', 'space/md'],
    ['var', 'set-value', '-m', 'Mode 1', '--alias', 'space/lg', 'space/md', '20'],
    ['var', 'set-value', '-m', 'Mode 1', '--future', 'private-value', 'space/md'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Code Syntax closes set/remove as policy-identical non-retrying writes', () => {
  for (const [cliArgv, mcpArgv] of [
    [
      ['var', 'code-syntax', '-cTokens', 'space/md', 'web', 'var(--space-md)'],
      ['var', 'code-syntax', '--collection=Tokens', '--', 'space/md', 'WEB', 'var(--space-md)'],
    ],
    [
      ['var', 'code-syntax', '--remove', 'space/md', 'ios'],
      ['var', 'code-syntax', '--remove', '--', 'space/md', 'iOS'],
    ],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.confirmation, 'configured');
    assert.equal(cli.audit.capability, 'var.code-syntax');
  }
  for (const argv of [
    ['var', 'code-syntax', 'space/md', 'WEB'],
    ['var', 'code-syntax', '--remove', 'space/md', 'WEB', 'value'],
    ['var', 'code-syntax', 'space/md', 'FUTURE', 'value'],
    ['var', 'code-syntax', '--future', 'private-value', 'space/md', 'WEB'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Update closes one policy-identical field-rollback non-retrying write', () => {
  const cli = planFigmaCommand([
    'var', 'update', '-cTokens', '-dMedium', '--hidden=false', '--scopes=GAP', 'space/md',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'update', '--collection=Tokens', '--description=Medium', '--hidden', 'false',
    '--scopes', 'GAP', '--', 'space/md',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'var.update');
  for (const argv of [
    ['var', 'update', 'space/md'],
    ['var', 'update', '-c', 'Tokens', 'space/md'],
    ['var', 'update', '--hidden', 'maybe', 'space/md'],
    ['var', 'update', '--scopes', 'FUTURE', 'space/md'],
    ['var', 'update', '--future', 'private-value', 'space/md'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Deletion closes exact scoped batches as policy-identical non-retrying writes', () => {
  const cli = planFigmaCommand([
    'var', 'delete', '-cPrimitives', 'space/md', 'space/lg',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'delete', '--collection=Primitives', '--', 'space/md', 'space/lg',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, 'var.delete');
  for (const argv of [
    ['var', 'delete'],
    ['var', 'delete', 'space/md', 'space/md'],
    ['var', 'delete', '--collection', 'Primitives'],
    ['var', 'delete', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Collection Catalog and Facts close policy-identical safe reads', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [['col', 'list', '--json', '--limit', '25'], ['col', 'list', '-l25', '--json'], 'col.list'],
    [['col', 'show', 'Theme'], ['col', 'show', '--', 'Theme'], 'col.show'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.execution.retry, 'safe-read');
    assert.equal(cli.audit.capability, action);
  }
  for (const argv of [
    ['col', 'list', '--future'], ['col', 'list', 'private-value'],
    ['col', 'show'], ['col', 'show', 'one', 'two'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
  const urlShapedName = planFigmaCommand([
    'col', 'show', 'https://www.figma.com/design/FILEA/Payload?node-id=10-2',
  ], { adapter: 'mcp' });
  assert.equal(urlShapedName.allowed, true);
  assert.equal(urlShapedName.target.fileKey, null,
    'a URL-shaped Collection name is payload, never Figma Target Context');
});

test('Token Publish Status closes Variable and Collection safe reads', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [
      ['var', 'publish-status', 'space/md', '--collection', 'Primitives'],
      ['var', 'publish-status', '--collection=Primitives', '--', 'space/md'],
      'var.publish-status',
    ],
    [
      ['col', 'publish-status', 'Theme'],
      ['col', 'publish-status', '--', 'Theme'],
      'col.publish-status',
    ],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.execution.retry, 'safe-read');
    assert.equal(cli.audit.capability, action);
  }
  for (const argv of [
    ['var', 'publish-status'], ['var', 'publish-status', 'one', 'two'],
    ['col', 'publish-status', '--collection', 'Theme', 'Theme'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Collection Create closes one policy-identical non-retrying journaled write', () => {
  const cli = planFigmaCommand(['col', 'create', '--allow-duplicate', 'Theme'], {
    adapter: 'cli',
  });
  const mcp = planFigmaCommand(['col', 'create', '--allow-duplicate', '--', 'Theme'], {
    adapter: 'mcp',
  });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.idempotence, 'unknown');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'col.create');
  for (const argv of [
    ['col', 'create'], ['col', 'create', 'one', 'two'],
    ['col', 'create', '--allow-duplicate', '--allow-duplicate', 'Theme'],
    ['col', 'create', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Collection Update closes one policy-identical non-retrying rollback-owned write', () => {
  const cli = planFigmaCommand([
    'col', 'update', '-nCore', '--hidden=false', 'Primitives',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'col', 'update', '--name=Core', '--hidden', 'false', '--', 'Primitives',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.idempotence, 'unknown');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'col.update');
  for (const argv of [
    ['col', 'update', 'Primitives'],
    ['col', 'update', '--name', 'One', '--name', 'Two', 'Primitives'],
    ['col', 'update', '--hidden', 'maybe', 'Primitives'],
    ['col', 'update', '--future', 'private-value', 'Primitives'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Collection Mode actions close policy-identical non-retrying writes', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [
      ['col', 'mode-add', 'Primitives', 'Dark'],
      ['col', 'mode-add', '--', 'Primitives', 'Dark'],
      'col.mode-add',
    ],
    [
      ['col', 'mode-rename', 'Primitives', 'Dark', 'Night'],
      ['col', 'mode-rename', '--', 'Primitives', 'Dark', 'Night'],
      'col.mode-rename',
    ],
    [
      ['col', 'mode-remove', 'Primitives', 'Night'],
      ['col', 'mode-remove', '--', 'Primitives', 'Night'],
      'col.mode-remove',
    ],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.confirmation, 'configured');
    assert.equal(cli.audit.capability, action);
  }
  for (const argv of [
    ['col', 'mode-add', 'Primitives'],
    ['col', 'mode-add', '--future', 'private-value', 'Dark'],
    ['col', 'mode-rename', 'Primitives', 'Dark'],
    ['col', 'mode-remove', 'Primitives', 'Dark', 'extra'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Collection Delete closes one irreversible policy-identical non-retrying write', () => {
  const cli = planFigmaCommand(['col', 'delete', 'Disposable'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['col', 'delete', '--', 'Disposable'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, 'col.delete');
  for (const argv of [
    ['col', 'delete'], ['col', 'delete', 'one', 'two'],
    ['col', 'delete', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Collection Extension closes one journaled policy-identical non-retrying write', () => {
  const cli = planFigmaCommand(['col', 'extend', 'Primitives', 'Brand'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['col', 'extend', '--', 'Primitives', 'Brand'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, 'col.extend');
  for (const argv of [
    ['col', 'extend'], ['col', 'extend', 'Primitives'],
    ['col', 'extend', 'Primitives', 'Brand', 'extra'],
    ['col', 'extend', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Style Consumer closes one longer policy-identical CLI/MCP safe read', () => {
  const cli = planFigmaCommand([
    'style', 'consumers', '--type', 'paint', '--limit', '25', 'Surface',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'consumers', '--limit=25', '-tPAINT', '--', 'Surface',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.execution.timeout, 'long');
  assert.equal(cli.audit.capability, 'style.consumers');
  assert.equal(cli.execution.pluginDispatch, 'typed-read');
});

test('Style Publish Status closes one compact policy-identical CLI/MCP safe read', () => {
  const cli = planFigmaCommand([
    'style', 'publish-status', '--type', 'text', 'Body',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'publish-status', '-tTEXT', '--', 'Body',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.audit.capability, 'style.publish-status');
});

test('Style Apply closes one targeted policy-identical non-retrying write', () => {
  const cli = planFigmaCommand([
    'style', 'apply', 'Surface', '10-2,10:3', '--field', 'fill',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'apply', '--field=FILL', '--', 'Surface', '10:2,10:3',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'style.apply');
});

test('Style Create closes one policy-identical non-retrying journaled write', () => {
  const cli = planFigmaCommand([
    'style', 'create', 'PAINT', 'Surface', '--properties', '{"paints":[]}',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'create', '--properties={"paints":[]}', '--', 'paint', 'Surface',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'style.create');
});

test('Style Update closes one policy-identical non-retrying rollback-owned write', () => {
  const cli = planFigmaCommand([
    'style', 'update', 'Columns/Auto', '--type', 'GRID', '--description', 'Responsive',
    '--properties', '{"layoutGrids":[]}',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'update', '--properties={"layoutGrids":[]}', '-dResponsive', '-tgrid',
    '--', 'Columns/Auto',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'style.update');
});

test('Style Delete closes one policy-identical non-retrying destructive write', () => {
  const cli = planFigmaCommand(['style', 'delete', 'Disposable', '--type', 'GRID'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['style', 'delete', '-tgrid', '--', 'Disposable'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'style.delete');
});

test('Text Style bind and unbind close policy-identical non-retrying writes', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [['style','bind-font','Body','fontSize','--variable','size/body'], ['style','bind-font','--variable=size/body','--','Body','fontSize'], 'style.bind-font'],
    [['style','unbind-font','Body','fontSize'], ['style','unbind-font','--','Body','fontSize'], 'style.unbind-font'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' }); const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true); assert.deepEqual(cli.argv, mcp.argv); assert.equal(cli.execution.retry, 'never'); assert.equal(cli.audit.capability, action);
  }
});

test('Layout Grid Facts closes one policy-identical CLI/MCP safe read', () => {
  const cli = planFigmaCommand(['grid', 'list', '10-3', '--json'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['grid', 'list', '--json', '10:3'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.audit.capability, 'grid.list');
});

test('literal help after the option terminator retains write policy and Audit classification', () => {
  const plan = planFigmaCommand(['node', 'set-text', '1:2', '--', '--help']);

  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'node.set-text');
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.confirmation, 'configured');
  assert.deepEqual(plan.target, {
    kind: 'plugin-file',
    fileKey: null,
    source: 'implicit-single-window',
  });
  assert.deepEqual(plan.availability, {
    transport: 'plugin',
    editor: 'figma',
    feature: null,
  });
  assert.equal(plan.audit.capability, 'node.set-text');
  assert.equal(plan.audit.operation, 'write');
  assert.equal(plan.audit.effects.figma, 'write');
  assert.equal(plan.audit.targetKind, 'plugin-file');
});

test('literal payload cannot impersonate mutation, target, network, or output policy', () => {
  for (const literal of ['--print-browser-capture', '--structural-gate', '--verify']) {
    const plan = planFigmaCommand(['render', '--', literal], { workspaceDir: '/work' });
    assert.equal(plan.allowed, true, literal);
    assert.equal(plan.effects.figma, 'write', literal);
    assert.equal(plan.target.kind, 'plugin-file', literal);
    assert.equal(plan.execution.timeout, 'long', literal);
    assert.equal(plan.execution.retry, 'never', literal);
    assert.deepEqual(plan.outputs, [], literal);
  }

  const tokenLiteral = planFigmaCommand(['tokens', 'sync', '--', '--apply'], {
    workspaceDir: '/work',
  });
  assert.equal(tokenLiteral.effects.figma, 'read');
  assert.equal(tokenLiteral.confirmation, 'none');
  assert.deepEqual(tokenLiteral.argv, ['tokens', 'sync', '--', '/work/--apply']);
  assert.equal(planFigmaCommand(['tokens', 'sync', '--apply', 'tokens.json'], {
    workspaceDir: '/work',
  }).effects.figma, 'write');

  const gradientLiteral = planFigmaCommand(['gradient', 'extract', '--', '--apply-to'], {
    workspaceDir: '/work',
  });
  assert.equal(gradientLiteral.effects.figma, 'none');
  assert.equal(gradientLiteral.target.kind, 'none');
  assert.deepEqual(gradientLiteral.argv, ['gradient', 'extract', '--', '/work/--apply-to']);
  assert.equal(planFigmaCommand([
    'gradient', 'extract', 'hero.png', '--apply-to', '1:2',
  ], { workspaceDir: '/work' }).effects.figma, 'write');

  assert.equal(planFigmaCommand(['spec', '--', '--check']).target.kind, 'none');
  assert.equal(planFigmaCommand(['spec', 'Button', '--check', '1:2']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand(['verify-build', '--', '--node'], {
    workspaceDir: '/work',
  }).target.kind, 'none');
  assert.equal(planFigmaCommand(['verify-build', '.', '--node', '1:2'], {
    workspaceDir: '/work',
  }).target.kind, 'plugin-file');

  const outputLiteral = planFigmaCommand(['export', 'node', '1:2', '--', '--output'], {
    workspaceDir: '/work',
  });
  assert.deepEqual(outputLiteral.argv, [
    'export', 'node', '1:2', '-o', '/work/node-export.png', '--', '--output',
  ]);
  assert.equal(outputLiteral.outputs[0].path, '/work/node-export.png');

  const networkLiteral = planFigmaCommand([
    'kit', 'init', '.', '--', '--storybook=https://example.test/private',
  ], { workspaceDir: '/work' });
  assert.equal(networkLiteral.effects.network, 'none');
  assert.equal(planFigmaCommand([
    'map', 'storybook', '--output', 'map.json', 'https://example.test/storybook',
  ], { workspaceDir: '/work' }).effects.network, 'read');
  assert.equal(planFigmaCommand([
    'map', 'storybook', '--', '--output=https://example.test/literal',
  ], { workspaceDir: '/work' }).effects.network, 'none');

  const historyLiteral = planFigmaCommand(['history', 'save', '--', '--json']);
  assert.equal(historyLiteral.effects.figma, 'write');
  assert.equal(historyLiteral.effects.shared, 'none');
});

test('policy options reject unknown, duplicate, missing, and conflicting forms before planning', () => {
  for (const args of [
    ['export', 'node', '1:2', '--output', 'one.png', '--output', 'two.png'],
    ['spec', 'Button', '--file', 'one.md', '--file', 'two.md'],
    ['export', 'node', '1:2', '--output', '--', 'literal'],
    ['gradient', 'extract', 'hero.png', '--apply-to'],
    ['tokens', 'sync', 'tokens.json', '--ours', '--theirs'],
    ['verify-build', '.', '--unknown-policy'],
  ]) {
    const plan = planFigmaCommand(args, { workspaceDir: '/work' });
    assert.equal(plan.allowed, false, args.join(' '));
    assert.equal(plan.id, 'unknown', args.join(' '));
    assert.deepEqual(plan.effects, {
      figma: 'none', workspace: 'none', network: 'none', shared: 'none',
    }, args.join(' '));
    assert.equal(plan.target.kind, 'none', args.join(' '));
  }
});

test('short-attached Legacy option values keep Commander meaning during path planning', () => {
  const exportPlan = planFigmaCommand([
    'export', 'node', '1:2', '-onode.png', '-fpng', '-s2',
  ], { workspaceDir: '/work' });
  assert.equal(exportPlan.allowed, true);
  assert.deepEqual(exportPlan.argv, [
    'export', 'node', '1:2', '-o/work/node.png', '-fpng', '-s2',
  ]);
  assert.equal(exportPlan.outputs[0].path, '/work/node.png');

  const specPlan = planFigmaCommand([
    'spec', 'Button', '-fDESIGN.md',
  ], { workspaceDir: '/work' });
  assert.equal(specPlan.allowed, true);
  assert.deepEqual(specPlan.argv, ['spec', 'Button', '-f/work/DESIGN.md']);
});

test('CLI and MCP receive identical option-region and literal-payload plans', () => {
  for (const args of [
    ['tokens', 'sync', '--', '--apply'],
    ['gradient', 'extract', '--', '--apply-to'],
    ['render', '--', '--verify'],
    ['export', 'node', '1:2', '--', '--output'],
  ]) {
    const options = { workspaceDir: '/work' };
    const mcp = planFigmaCommand(args, { ...options, adapter: 'mcp' });
    const cli = planFigmaCommand(args, { ...options, adapter: 'cli' });
    const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPlan } = mcp;
    const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPlan } = cli;
    assert.deepEqual(cliPlan, mcpPlan, args.join(' '));
  }
});

test('Node Text closes and canonicalizes one policy-identical CLI/MCP request', () => {
  const url = 'https://www.figma.com/design/FILEA/Text-Lab?node-id=12-34';
  const input = ['node', 'set-text', url, '--', '--help'];
  const mcp = planFigmaCommand(input, { adapter: 'mcp' });
  const cli = planFigmaCommand(input, { adapter: 'cli' });

  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(mcp.argv, ['node', 'set-text', '12:34', '--', '--help']);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');

  const payloadUrl = 'https://www.figma.com/design/PAYLOADPLACEHOLDERKEY/FILE_NAME?node-id=9-9';
  const payloadPlan = planFigmaCommand(['node', 'set-text', '1:2', payloadUrl]);
  assert.equal(payloadPlan.target.fileKey, null,
    'the text payload must never impersonate Figma Target Context');
  assert.equal(payloadPlan.target.source, 'implicit-single-window');

  for (const nodeUrl of [
    `  ${url}  `,
    'www.figma.com/design/FILEA/Text-Lab?node-id=12-34',
  ]) {
    const urlPlan = planFigmaCommand(['node', 'set-text', nodeUrl, 'Hello']);
    assert.equal(urlPlan.target.fileKey, 'FILEA');
    assert.equal(urlPlan.target.source, 'figma-url');
    assert.equal(urlPlan.argv[2], '12:34');
  }

  for (const args of [
    ['node', 'set-text'],
    ['node', 'set-text', '1:2'],
    ['node', 'set-text', '1:2', '--future'],
    ['node', 'set-text', '1:2', 'Hello', 'extra'],
    ['node', 'set-text', '1:2', '--'],
  ]) {
    const rejected = planFigmaCommand(args);
    assert.equal(rejected.allowed, false, args.join(' '));
    assert.equal(rejected.id, 'unknown', args.join(' '));
  }
});

test('Inspect closes one policy-identical CLI/MCP read without losing formats or URL targets', () => {
  const url = 'https://www.figma.com/design/FILEA/Inspect-Lab?node-id=12-34';
  for (const input of [
    ['inspect', url, '--format', 'yaml'],
    ['inspect', '--json', url],
    ['inspect', url, '--json'],
    ['inspect', url, '--spec', '--format=yaml'],
  ]) {
    const mcp = planFigmaCommand(input, { adapter: 'mcp' });
    const cli = planFigmaCommand(input, { adapter: 'cli' });
    const { adapter: _mcpAdapter, ...mcpPolicy } = mcp;
    const { adapter: _cliAdapter, ...cliPolicy } = cli;
    assert.equal(mcp.allowed, true, input.join(' '));
    assert.equal(cli.allowed, true, input.join(' '));
    assert.deepEqual(cliPolicy, mcpPolicy, input.join(' '));
    assert.equal(mcp.target.fileKey, 'FILEA');
    assert.equal(mcp.target.source, 'figma-url');
    assert.equal(mcp.argv[1], '12:34');
    assert.equal(mcp.execution.retry, 'safe-read');
    assert.equal(mcp.execution.timeout, 'default');
    assert.deepEqual(mcp.execution.okExitCodes, [0]);
  }

  for (const args of [
    ['inspect'],
    ['inspect', '1:2', '3:4'],
    ['inspect', '1:2', '--future', 'private-value'],
    ['inspect', '1:2', '--format', 'toml'],
  ]) {
    const rejected = planFigmaCommand(args);
    assert.equal(rejected.allowed, false, args.join(' '));
    assert.equal(rejected.id, 'unknown', args.join(' '));
  }
});

test('Code Spec closes one policy-identical CLI/MCP capture request', () => {
  const url = 'https://www.figma.com/design/FILEA/Spec-Lab?node-id=12-34';
  const inputs = [
    ['export', 'code-spec', url],
    ['export', 'code-spec', '--format', 'yaml', '--depth=0', url, '--phase', 'style', '--no-dedup'],
  ];
  for (const input of inputs) {
    const mcp = planFigmaCommand(input, { adapter: 'mcp' });
    const cli = planFigmaCommand(input, { adapter: 'cli' });
    const { adapter: _mcp, ...mcpPolicy } = mcp;
    const { adapter: _cli, ...cliPolicy } = cli;
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.deepEqual(cliPolicy, mcpPolicy);
    assert.equal(mcp.target.fileKey, 'FILEA');
    assert.equal(mcp.argv[2], '12:34');
    assert.equal(mcp.execution.retry, 'safe-read');
  }
});

test('Screenshot plans keep Adapter policy identical across temp, workspace and inline persistence', () => {
  const url = 'https://www.figma.com/design/FILEA/Shot?node-id=12-34';
  const cases = [
    { argv: ['verify', url], workspace: 'none', shared: 'write', outputs: 1 },
    { argv: ['verify', url, '--save', 'shots/card.png'], workspace: 'write', shared: 'none', outputs: 1 },
    { argv: ['verify', url, '--base64'], workspace: 'none', shared: 'none', outputs: 0 },
  ];
  for (const expected of cases) {
    const options = {
      workspaceDir: '/work',
      fileKey: null,
      verificationArtifactNonce: 'cross-adapter-screenshot-0001',
    };
    const mcp = planFigmaCommand(expected.argv, { ...options, adapter: 'mcp' });
    const cli = planFigmaCommand(expected.argv, { ...options, adapter: 'cli' });
    const { adapter: _mcp, ...mcpPolicy } = mcp;
    const { adapter: _cli, ...cliPolicy } = cli;
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.deepEqual(cliPolicy, mcpPolicy);
    assert.equal(mcp.target.fileKey, 'FILEA');
    assert.equal(mcp.argv[1], '12:34');
    assert.equal(mcp.effects.workspace, expected.workspace);
    assert.equal(mcp.effects.shared, expected.shared);
    assert.equal(mcp.outputs.length, expected.outputs);
  }
});

test('every exposed command root owns a closed URL target projection', () => {
  assert.deepEqual(
    Object.keys(FIGMA_URL_TARGET_ROOTS).sort(),
    listFigmaCapabilities().map(({ name }) => name).sort(),
  );
  assert.deepEqual(figmaUrlTargetProjectionContract('render'), []);
  assert.deepEqual(figmaUrlTargetProjectionContract('node.rename'), [
    { kind: 'position', index: 2, from: null, flags: [] },
  ]);

  const actionIds = new Set();
  const visit = (node, parent = '') => {
    const actionId = parent ? `${parent}.${node.name}` : node.name;
    if (node.positionalAction) actionIds.add(`${actionId}.${node.positionalAction}`);
    if (node.children.length === 0) actionIds.add(actionId);
    for (const child of node.children) visit(child, actionId);
  };
  for (const root of listFigmaCommandGrammar()) visit(root);
  for (const actionId of listFigmaUrlTargetActions()) {
    assert.equal(actionIds.has(actionId), true, `${actionId} is not in the closed Command Grammar`);
  }
});

test('only semantic node fields may derive a Figma URL target', () => {
  const targetUrl = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=12-34';
  const payloadUrl = 'https://www.figma.com/design/PAYLOADPLACEHOLDERKEY/FILE_NAME?node-id=98-76';

  for (const argv of [
    ['node', 'rename', '1:2', payloadUrl],
    ['node', 'set-text', '1:2', payloadUrl],
    ['render', `<Frame name="${payloadUrl}" />`],
    ['render', `<Frame><Rectangle src="${payloadUrl}" /></Frame>`],
    ['annotate', 'add', payloadUrl, '--node', '1:2'],
    ['tokens', 'add', 'semantic/name', payloadUrl],
    ['var', 'set-value', 'semantic/name', payloadUrl],
    ['dev', 'link', '1:2', payloadUrl],
    ['link', 'set', '1:2', payloadUrl],
    ['import', payloadUrl],
    ['map', 'storybook', payloadUrl],
    ['create', 'frame', payloadUrl],
    ['analyze', 'colors', '--node', payloadUrl],
    ['gradient', 'apply', '1:2', payloadUrl],
    ['history', 'save', payloadUrl],
    ['jam', 'sticky', payloadUrl],
    ['slides', 'create', payloadUrl],
  ]) {
    const plan = planFigmaCommand(argv);
    assert.equal(plan.target.fileKey, null, argv.join(' '));
    assert.equal(plan.target.source, 'implicit-single-window', argv.join(' '));
  }

  for (const argv of [
    ['node', 'rename', targetUrl, 'Renamed'],
    ['annotate', 'add', 'Note', '--node', targetUrl],
    ['create', 'frame', 'Card', '--parent', targetUrl],
    ['prototype', 'add', targetUrl, '--navigate-to', targetUrl],
    ['verify-build', '.', '--node', targetUrl],
  ]) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    assert.equal(mcp.target.fileKey, 'TARGETPLACEHOLDERKEY', argv.join(' '));
    assert.equal(mcp.target.source, 'figma-url', argv.join(' '));
    assert.deepEqual(cli.target, mcp.target, argv.join(' '));
    assert.deepEqual(cli.argv, mcp.argv, argv.join(' '));
    assert.deepEqual(cli.effects, mcp.effects, argv.join(' '));
    assert.equal(cli.confirmation, mcp.confirmation, argv.join(' '));
    assert.deepEqual(cli.audit, mcp.audit, argv.join(' '));
  }

  const schemaless = planFigmaCommand([
    'inspect',
    '  www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=12-34  ',
  ]);
  assert.equal(schemaless.target.fileKey, 'TARGETPLACEHOLDERKEY');
});

test('conflicting semantic node URLs stop before one target is selected', () => {
  assert.throws(
    () => planFigmaCommand([
      'prototype',
      'add',
      'https://www.figma.com/design/FIRSTPLACEHOLDERKEY/FILE_NAME?node-id=1-2',
      '--navigate-to',
      'https://www.figma.com/design/SECONDPLACEHOLDERKEY/FILE_NAME?node-id=3-4',
    ]),
    /target-bearing fields reference multiple Figma files/,
  );

  const explicit = planFigmaCommand([
    'prototype',
    'add',
    'https://www.figma.com/design/FIRSTPLACEHOLDERKEY/FILE_NAME?node-id=1-2',
    '--navigate-to',
    'https://www.figma.com/design/SECONDPLACEHOLDERKEY/FILE_NAME?node-id=3-4',
  ], { fileKey: 'EXPLICITPLACEHOLDERKEY' });
  assert.equal(explicit.target.fileKey, 'EXPLICITPLACEHOLDERKEY');
  assert.equal(explicit.target.source, 'explicit');
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
  assert.equal(planFigmaCommand(['render', '--print-browser-capture', '.screen']).target.kind, 'none');
  assert.equal(planFigmaCommand(['render', '<Frame name="Audit" />', '--structural-gate']).target.kind, 'none');
  assert.deepEqual(planFigmaCommand(['render', '<Frame name="Audit" />', '--structural-gate']).execution.okExitCodes, [0, 1]);
  assert.equal(planFigmaCommand(['render', '<Frame/>']).execution.timeout, 'long');
  assert.equal(planFigmaCommand(['export', 'assets', '1:2']).execution.mode, 'tracked-job');
  assert.equal(planFigmaCommand(['export', 'assets', '1:2']).execution.timeout, 'background');
  assert.deepEqual(planFigmaCommand(['history', 'diff', 'latest', 'live']).execution.okExitCodes, [0, 1]);
  assert.deepEqual(planFigmaCommand(['verify-build', '.']).execution.okExitCodes, [0, 1]);
  assert.equal(planFigmaCommand(['slides', 'inspect']).availability.editor, 'slides');
  assert.equal(planFigmaCommand(['slides', 'inspect']).availability.feature, 'slides-beta');
  assert.equal(planFigmaCommand(['link', 'list']).target.kind, 'none');
  assert.equal(planFigmaCommand(['link', 'configure', '--tokens', 'tokens.json']).target.kind, 'none');
  assert.equal(planFigmaCommand(['link', 'inspect', '1:2']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand(['link', 'inspect', '1:2']).execution.retry, 'safe-read');
  assert.equal(planFigmaCommand(['link', 'context', 'ui.button']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand(['link', 'set', '1:2', 'ui.button']).availability.feature, 'design-links');
});

test('CLI and MCP decide identical policy for the Design Link tracer only', () => {
  const cases = [
    {
      argv: ['link', 'inspect', '1:2', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'read', workspace: 'read', network: 'none', shared: 'none' },
      confirmation: 'none',
      retry: 'safe-read',
    },
    {
      argv: ['link', 'set', '1:2', 'ui.button', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'write', workspace: 'write', network: 'none', shared: 'none' },
      confirmation: 'configured',
      retry: 'never',
    },
  ];
  for (const expected of cases) {
    const options = { workspaceDir: '/work', fileKey: 'FILE_A' };
    const mcp = planFigmaCommand(expected.argv, { ...options, adapter: 'mcp' });
    const cli = planFigmaCommand(expected.argv, { ...options, adapter: 'cli' });
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.effects, expected.effects);
    assert.equal(cli.confirmation, expected.confirmation);
    assert.equal(cli.execution.retry, expected.retry);
    assert.equal(cli.execution.timeout, mcp.execution.timeout);
    assert.deepEqual(cli.target, mcp.target);
    const { adapter: mcpAdapter, ...mcpPolicy } = mcp;
    const { adapter: cliAdapter, ...cliPolicy } = cli;
    assert.equal(mcpAdapter, 'mcp');
    assert.equal(cliAdapter, 'cli');
    assert.deepEqual(cliPolicy, mcpPolicy);
  }

  for (const argv of [
    ['link', 'list'],
    ['link', 'configure', '--tokens', 'tokens.json'],
    ['link', 'status', 'ui.button'],
    ['link', 'accept', 'ui.button'],
    ['link', 'context', 'ui.button'],
  ]) assert.equal(planFigmaCommand(argv, { adapter: 'cli' }).allowed, false, argv.join(' '));
});

test('Design Link planning fails closed on malformed argv and keeps inspect registry reads optional', () => {
  for (const argv of [
    ['link', 'inspect', '--future', 'secret'],
    ['link', 'inspect', '--manifest'],
    ['link', 'inspect', '1:2', '3:4'],
    ['link', 'set', '1:2'],
    ['link', 'set', '1:2', 'ui.button', '--kind'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));

  const intents = [];
  const plan = planFigmaCommand(['link', 'inspect', '1:2'], {
    workspaceDir: '/work',
    workspaceIO: {
      authorizePath(path, intent) { intents.push({ path, ...intent }); },
    },
  });
  assert.equal(plan.allowed, true);
  assert.deepEqual(intents, [{
    path: '/work/figma-bridge.json',
    access: 'read-optional',
    role: 'design-link-manifest',
    kind: 'file',
  }]);
});

test('CLI and MCP decide identical policy and accepted outcomes for Design Contracts', () => {
  const cases = [
    {
      argv: ['contract', 'capture', 'ui.button', '--manifest', '/work/figma-bridge.json', '--file', '/work/ui.button.json'],
      effects: { figma: 'read', workspace: 'write', network: 'none', shared: 'none' },
      okExitCodes: [0],
    },
    {
      argv: ['contract', 'check', 'ui.button', '--manifest', '/work/figma-bridge.json', '--file', '/work/ui.button.json'],
      effects: { figma: 'read', workspace: 'read', network: 'none', shared: 'none' },
      okExitCodes: [0, 1],
    },
  ];
  for (const expected of cases) {
    const options = { workspaceDir: '/work', fileKey: 'FILE_A' };
    const mcp = planFigmaCommand(expected.argv, { ...options, adapter: 'mcp' });
    const cli = planFigmaCommand(expected.argv, { ...options, adapter: 'cli' });
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.effects, expected.effects);
    assert.equal(cli.confirmation, 'none');
    assert.equal(cli.execution.retry, 'never');
    assert.deepEqual(cli.execution.okExitCodes, expected.okExitCodes);
    assert.deepEqual(cli.target, mcp.target);
    const { adapter: mcpAdapter, ...mcpPolicy } = mcp;
    const { adapter: cliAdapter, ...cliPolicy } = cli;
    assert.equal(mcpAdapter, 'mcp');
    assert.equal(cliAdapter, 'cli');
    assert.deepEqual(cliPolicy, mcpPolicy);
  }

  for (const argv of [
    ['contract', 'capture'],
    ['contract', 'check', 'ui.button', '--future', 'secret'],
    ['contract', 'capture', 'ui.button', '--file'],
    ['contract', 'check', 'ui.button', 'extra'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('one Command Plan resolves its Figma Target Context after path normalization', () => {
  let targetResolutions = 0;
  let authorizedPaths = 0;
  const plan = planFigmaCommand(['link', 'context', 'screen.settings'], {
    workspaceDir: '/work/project',
    workspaceIO: {
      authorizePath(path, intent) {
        authorizedPaths++;
        assert.equal(path, '/work/project/figma-bridge.json');
        assert.equal(intent.role, 'design-link-manifest');
      },
    },
    registryFileKey(argv) {
      targetResolutions++;
      assert.deepEqual(argv.slice(-2), ['--manifest', '/work/project/figma-bridge.json']);
      assert.equal(Object.isFrozen(argv), true);
      return 'REGISTRYPLACEHOLDERKEY';
    },
  });

  assert.equal(targetResolutions, 1);
  assert.equal(authorizedPaths, 1);
  assert.deepEqual(plan.target, {
    kind: 'plugin-file',
    fileKey: 'REGISTRYPLACEHOLDERKEY',
    source: 'design-link-registry',
  });
  assert.equal(Object.isFrozen(plan.target), true);
});

test('catalog prepares every known project-relative path policy', () => {
  const base = resolve('work', 'project');
  const inWorkspace = (...parts) => join(base, ...parts);
  const argv = (args) => planFigmaCommand(args, { workspaceDir: base }).argv;
  assert.deepEqual(argv(['extract']).slice(-1), [inWorkspace('DESIGN.md')]);
  assert.deepEqual(argv(['export', 'assets', '1:2']).slice(-2), ['-o', inWorkspace('assets')]);
  assert.deepEqual(argv(['export', 'node', '1:2', '--output=shot.png']).slice(-1), [`--output=${inWorkspace('shot.png')}`]);
  assert.deepEqual(argv(['export', 'node-json', '1:2', '--output=facts.json']).slice(-1), [`--output=${inWorkspace('facts.json')}`]);
  assert.deepEqual(argv(['export', 'node-json', '1:2', '-o=facts.json']).slice(-1), [`-o=${inWorkspace('facts.json')}`]);
  assert.deepEqual(argv(['export', 'node-json', '1:2']), ['export', 'node-json', '1:2']);
  assert.deepEqual(argv(['export', 'video', '1:2', '--format', 'gif']).slice(-2), ['-o', inWorkspace('video.gif')]);
  assert.deepEqual(argv(['map', 'storybook', 'url']).slice(-2), ['-o', inWorkspace('figma-map.json')]);
  assert.deepEqual(argv(['link', 'list']).slice(-2), ['--manifest', inWorkspace('figma-bridge.json')]);
  assert.deepEqual(argv(['link', 'set', '1:2', 'ui.button', '--manifest=design/links.json']).slice(-1), [
    `--manifest=${inWorkspace('design', 'links.json')}`,
  ]);
  assert.deepEqual(
    argv(['link', 'accept', 'screen.home', '--compare', 'shots/home.jpg']),
    ['link', 'accept', 'screen.home', '--compare', inWorkspace('shots', 'home.jpg'), '--manifest', inWorkspace('figma-bridge.json')],
  );
  assert.deepEqual(
    argv(['verify-build', '.', '--compare', 'shot.png']),
    ['verify-build', base, '--compare', inWorkspace('shot.png')],
  );
  assert.deepEqual(
    argv(['verify', '1:2', '--save', 'shot.png']),
    ['verify', '1:2', '--save', inWorkspace('shot.png')],
  );
  assert.deepEqual(
    argv(['render', '--dom-capture', 'captures/screen.json']),
    [
      'render', '--dom-capture', inWorkspace('captures', 'screen.json'),
      '--manifest', inWorkspace('figma-bridge.json'),
    ],
  );
  assert.deepEqual(argv(['node', 'set-image', '1:2', 'photo.png']), ['node', 'set-image', '1:2', inWorkspace('photo.png')]);
  assert.deepEqual(argv(['tokens', 'sync', 'tokens.json', '--lockfile', '.tokens.lock.json']), [
    'tokens', 'sync', inWorkspace('tokens.json'), '--lockfile', inWorkspace('.tokens.lock.json'),
  ]);
  assert.deepEqual(argv(['spec', 'Button', '--file=design/DESIGN.md']), ['spec', 'Button', `--file=${inWorkspace('design', 'DESIGN.md')}`]);
  assert.deepEqual(argv(['motion', 'apply', 'motion.json']), ['motion', 'apply', inWorkspace('motion.json')]);
  assert.deepEqual(argv(['history', 'diff', 'latest', 'live', '--changelog', 'changes.md']), [
    'history', 'diff', 'latest', 'live', '--changelog', inWorkspace('changes.md'),
  ]);
  assert.deepEqual(argv(['export', 'dtcg', 'tokens.json']), ['export', 'dtcg', inWorkspace('tokens.json')]);
  assert.deepEqual(argv(['export', 'dtcg', '12:34']), ['export', 'dtcg', '12:34']);
});

test('catalog reports workspace, network and shared-state effects independently from Figma effects', () => {
  assert.deepEqual(planFigmaCommand(['spec', 'Button', '--file', 'DESIGN.md'], { workspaceDir: '/work' }).effects, {
    figma: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.equal(planFigmaCommand(['tokens', 'sync', 'tokens.json'], { workspaceDir: '/work' }).effects.workspace, 'write');
  assert.equal(planFigmaCommand(['history', 'snapshot']).effects.shared, 'write');
  assert.equal(planFigmaCommand(['history', 'snapshot', '--json']).effects.shared, 'none');
  assert.equal(planFigmaCommand(['history', 'list']).effects.shared, 'read');
  assert.deepEqual(planFigmaCommand(['api', 'setup']).effects, {
    figma: 'none', workspace: 'none', network: 'read', shared: 'write',
  });
  assert.deepEqual(planFigmaCommand(['api', 'index']).effects, {
    figma: 'none', workspace: 'none', network: 'none', shared: 'write',
  });
  assert.deepEqual(planFigmaCommand(['api', 'context']).effects, {
    figma: 'none', workspace: 'none', network: 'none', shared: 'write',
  });
  assert.deepEqual(planFigmaCommand(['api', 'SceneNode']).effects, {
    figma: 'none', workspace: 'none', network: 'none', shared: 'read',
  });
  assert.deepEqual(planFigmaCommand(['api']).effects, {
    figma: 'none', workspace: 'none', network: 'none', shared: 'none',
  });
  assert.equal(planFigmaCommand(['map', 'storybook', 'http://localhost:6006']).effects.network, 'read');
  assert.equal(planFigmaCommand(['map', 'storybook', './storybook-static']).effects.network, 'none');
  assert.equal(planFigmaCommand(['import', 'https://storybook.example.com']).effects.network, 'read');
  assert.equal(planFigmaCommand(['kit', 'init', '.', '--storybook=https://storybook.example.com']).effects.network, 'read');
  assert.deepEqual(planFigmaCommand(['link', 'set', '1:2', 'ui.button'], { workspaceDir: '/work' }).effects, {
    figma: 'write', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'list'], { workspaceDir: '/work' }).effects, {
    figma: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'accept', 'ui.button'], { workspaceDir: '/work' }).effects, {
    figma: 'read', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'context', 'ui.button'], { workspaceDir: '/work' }).effects, {
    figma: 'read', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'configure', '--tokens', 'tokens.json'], { workspaceDir: '/work' }).effects, {
    figma: 'none', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['export', 'node-json', '1:2', '-o', 'facts.json'], { workspaceDir: '/work' }).effects, {
    figma: 'read', workspace: 'write', network: 'none', shared: 'none',
  });
});

test('cross-Adapter conformance keeps policy identical while migration exposure stays explicit', () => {
  const cases = [
    ['export', 'code-spec', '1:2'],
    ['verify', '1:2', '--base64'],
    ['inspect', '1:2', '--format', 'yaml'],
    ['link', 'inspect', '1:2'],
    ['link', 'set', '1:2', 'ui.button'],
    ['export', 'assets', '1:2'],
    ['history', 'snapshot', '--json'],
    ['history', 'list'],
    ['history', 'diff', 'latest', 'live'],
    ['api', 'setup'],
    ['future-command', 'anything'],
  ];
  for (const argv of cases) {
    const options = { workspaceDir: '/work', fileKey: 'FILE_A' };
    const mcp = planFigmaCommand(argv, { ...options, adapter: 'mcp' });
    const cli = planFigmaCommand(argv, { ...options, adapter: 'cli' });
    const { adapter: mcpAdapter, allowed: mcpAllowed, ...mcpPolicy } = mcp;
    const { adapter: cliAdapter, allowed: cliAllowed, ...cliPolicy } = cli;
    assert.equal(mcpAdapter, 'mcp');
    assert.equal(cliAdapter, 'cli');
    assert.deepEqual(cliPolicy, mcpPolicy, argv.join(' '));
    if (['export.assets', 'export.code-spec', 'history.snapshot', 'history.list', 'history.diff', 'inspect', 'link.inspect', 'link.set', 'verify'].includes(mcp.id)) assert.equal(cliAllowed, mcpAllowed);
    else assert.equal(cliAllowed, false);
  }
  assert.equal(planFigmaCommand(['export', 'assets', '1:2']).execution.mode, 'tracked-job');
  assert.equal(planFigmaCommand(['future-command']).allowed, false);
});

test('History defaults and option order produce one cross-Adapter Command Plan', () => {
  const variants = [
    ['history', 'diff'],
    ['history', 'diff', 'previous', 'latest'],
    ['history', 'diff', '--max-items', '40'],
  ];
  const plans = variants.map((argv) => planFigmaCommand(argv, {
    adapter: 'mcp', workspaceDir: '/work', fileKey: 'FILE_A',
  }));
  for (const plan of plans) {
    assert.equal(plan.allowed, true);
    assert.deepEqual(plan.argv, ['history', 'diff', 'previous', 'latest']);
    assert.deepEqual(plan.execution.okExitCodes, [0, 1]);
    const cli = planFigmaCommand(plan.argv, {
      adapter: 'cli', workspaceDir: '/work', fileKey: 'FILE_A',
    });
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.target, plan.target);
    assert.deepEqual(cli.effects, plan.effects);
  }
});

test('Asset Export canonicalizes defaults into one cross-Adapter tracked-job policy', () => {
  const options = { workspaceDir: '/work', fileKey: 'FILE_A' };
  const variants = [
    ['export', 'assets', '1:2'],
    ['export', 'assets', '1:2', '-o', 'assets'],
    ['export', 'assets', '1:2', '--max', '100', '--raster-scale', '2'],
    ['export', 'assets', '--output=assets', '1:2'],
  ];
  const plans = variants.map((argv) => planFigmaCommand(argv, { ...options, adapter: 'mcp' }));
  for (const plan of plans) {
    const cli = planFigmaCommand(plan.argv, { ...options, adapter: 'cli' });
    assert.equal(plan.allowed, true);
    assert.equal(cli.allowed, true);
    assert.deepEqual(plan.effects, {
      figma: 'read', workspace: 'write', network: 'none', shared: 'none',
    });
    assert.equal(plan.confirmation, 'none');
    assert.equal(plan.execution.mode, 'tracked-job');
    assert.equal(plan.execution.timeout, 'background');
    assert.equal(plan.execution.retry, 'never');
    assert.deepEqual(cli.target, plan.target);
  }
  assert.equal(new Set(plans.map((plan) => plan.execution.jobKey)).size, 1);
  assert.equal(new Set(plans.map((plan) => JSON.stringify(plan.argv))).size, 1);
});

test('each capability supplies a closed audit projection without user payloads or identities', () => {
  const secret = '<Frame name="private customer name" />';
  const fileKey = 'SENSITIVEFILEKEY';
  const plan = planFigmaCommand(['render', secret, '--icons', '/private/project/icons.json'], {
    fileKey,
    workspaceDir: '/private/project',
  });
  assert.deepEqual(plan.audit, {
    capability: 'render',
    operation: 'write',
    effects: { figma: 'write', workspace: 'read', network: 'none', shared: 'none' },
    targetKind: 'plugin-file',
    outputRoles: [],
  });
  const serialized = JSON.stringify(plan.audit);
  assert.doesNotMatch(serialized, /private customer|private\/project|SENSITIVEFILEKEY/);

  const exported = planFigmaCommand(['export', 'assets', '1:2'], { workspaceDir: '/private/project' });
  assert.deepEqual(exported.audit.outputRoles, ['assets-dir']);
  assert.doesNotMatch(JSON.stringify(exported.audit), /private\/project/);

  const remoteStorybook = 'http://192.168.1.25:6006/private/index?credential=hidden';
  for (const args of [
    ['map', 'storybook', remoteStorybook],
    ['import', remoteStorybook],
    ['kit', 'init', '.', '--storybook', remoteStorybook],
  ]) {
    const audit = JSON.stringify(planFigmaCommand(args, { workspaceDir: '/private/project' }).audit);
    assert.doesNotMatch(audit, /192\.168|private|credential|hidden|6006/);
  }
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
