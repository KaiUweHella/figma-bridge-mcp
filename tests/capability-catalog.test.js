import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  explainFigmaCommandRejection,
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
  assert.equal(planFigmaCommand(['eval', 'figma.currentPage.id'], { adapter: 'mcp' }).allowed, false);
  assert.equal(names.includes('render'), true);
  assert.equal(planFigmaCommand(['--help']).allowed, true);
  assert.equal(planFigmaCommand(['--help']).target.kind, 'none');
});

test('Variable command aliases canonicalize and rejection facts stay precise and bounded', () => {
  const canonical = planFigmaCommand(['var', 'list'], { adapter: 'mcp' });
  const alias = planFigmaCommand(['variables', 'list'], { adapter: 'mcp' });
  assert.equal(canonical.allowed, true);
  assert.equal(alias.allowed, true);
  assert.deepEqual(alias.argv, canonical.argv);
  assert.equal(alias.id, 'var.list');
  const collectionAlias = planFigmaCommand(['collections', 'list'], { adapter: 'mcp' });
  assert.equal(collectionAlias.allowed, true);
  assert.equal(collectionAlias.id, 'col.list');
  assert.deepEqual(collectionAlias.argv, ['col', 'list', '--limit', '500']);

  const help = listFigmaCapabilities({ formatted: true });
  assert.match(help, /^var — Manage local variables \(alias: variables\)$/m);
  assert.match(help, /^col — Manage variable collections \(alias: collections\)$/m);

  const cases = [
    {
      args: ['future-group', 'private-payload'],
      pattern: /Unknown command group.*Accepted form: \["--help"\]/,
    },
    {
      args: ['var', 'future-action', 'private-payload'],
      pattern: /Unknown action for var.*Accepted actions:/,
    },
    {
      args: ['var', 'list', '--future', 'private-payload'],
      pattern: /Unsupported option --future for var list.*Accepted form:/,
    },
    {
      args: ['var', 'list', '--limit', '0'],
      pattern: /Malformed value for var list: limit must be an integer between 1 and 1000/,
    },
    {
      args: ['var', 'list', '--collection', 'private-payload'],
      pattern: /does not support --collection.*\["col","list"\].*filter returned Variable rows by collection identity/i,
    },
  ];
  for (const { args, pattern } of cases) {
    const message = explainFigmaCommandRejection(args);
    assert.match(message, pattern, args.join(' '));
    assert.ok(message.length <= 700, args.join(' '));
    assert.doesNotMatch(message, /private-payload/, args.join(' '));
  }
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

test('Slides Create owns one canonical cross-Adapter non-retrying write Plan', () => {
  const cli = planFigmaCommand(
    ['slides', 'create', '--row=1', '--col', '0', 'Agenda'], { adapter: 'cli' },
  );
  const mcp = planFigmaCommand(
    ['slides', 'create', 'Agenda', '--col=0', '--row', '1'], { adapter: 'mcp' },
  );
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'slides.create');
  assert.deepEqual(cli.argv, ['slides', 'create', '--row=1', '--col=0', 'Agenda']);
  assert.deepEqual(mcp.argv, cli.argv);
  assert.deepEqual(mcp.effects, cli.effects);
  assert.deepEqual(mcp.execution, cli.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'write');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.idempotence, 'unknown');
  for (const argv of [
    ['slides', 'create', '--col=0'],
    ['slides', 'create', '--row=-1'],
    ['slides', 'create', '--row=1', '--row=2'],
    ['slides', 'create', 'one', 'two'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Slides Duplicate owns one canonical cross-Adapter non-retrying write Plan', () => {
  const cli = planFigmaCommand(
    ['slides', 'duplicate', 'label:Body', '--row=1', '--col', '0', '--label=Copy'],
    { adapter: 'cli' },
  );
  const mcp = planFigmaCommand(
    ['slides', 'duplicate', '--label', 'Copy', '--col=0', '--row', '1', 'label:Body'],
    { adapter: 'mcp' },
  );
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'slides.duplicate');
  assert.deepEqual(cli.argv, [
    'slides', 'duplicate', 'label:Body', '--label=Copy', '--row=1', '--col=0',
  ]);
  assert.deepEqual(mcp.argv, cli.argv);
  assert.deepEqual(mcp.effects, cli.effects);
  assert.deepEqual(mcp.execution, cli.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'write');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  for (const argv of [
    ['slides', 'duplicate'],
    ['slides', 'duplicate', 'Body', '--col=0'],
    ['slides', 'duplicate', 'Body', '--row=-1'],
    ['slides', 'duplicate', 'one', 'two'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Slides Move owns one canonical cross-Adapter non-retrying write Plan', () => {
  const cli = planFigmaCommand(['slides', 'move', 'label:Body', '1', '0'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['slides', 'move', 'label:Body', '1', '0'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'slides.move');
  assert.deepEqual(cli.argv, ['slides', 'move', 'label:Body', '1', '0']);
  assert.deepEqual(mcp.argv, cli.argv);
  assert.deepEqual(mcp.effects, cli.effects);
  assert.deepEqual(mcp.execution, cli.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  for (const argv of [
    ['slides', 'move', 'Body', '0'],
    ['slides', 'move', 'Body', '-1', '0'],
    ['slides', 'move', 'Body', '0', '1.5'],
    ['slides', 'move', 'Body', '0', '1', 'extra'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Slides properties own canonical cross-Adapter non-retrying write Plans', () => {
  const pairs = [
    [
      ['slides', 'transition', 'label:Body', 'dissolve', '--timing', 'after_delay',
        '--delay=.25', '--curve', 'linear', '--duration=.333333'],
      ['slides', 'transition', 'label:Body', 'DISSOLVE', '--duration=0.3333',
        '--curve=LINEAR', '--timing=AFTER_DELAY', '--delay=0.25'],
      'slides.transition',
    ],
    [
      ['slides', 'skip', 'label:Body', 'true'],
      ['slides', 'skip', 'label:Body', 'on'],
      'slides.skip',
    ],
  ];
  for (const [raw, canonical, id] of pairs) {
    const cli = planFigmaCommand(raw, { adapter: 'cli' });
    const mcp = planFigmaCommand(canonical, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(cli.id, id);
    assert.deepEqual(cli.argv, canonical);
    assert.deepEqual(mcp.argv, canonical);
    assert.deepEqual(mcp.effects, cli.effects);
    assert.deepEqual(mcp.execution, cli.execution);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.effects.editor, 'none');
    assert.equal(cli.confirmation, 'configured');
    assert.equal(cli.execution.retry, 'never');
  }
  for (const argv of [
    ['slides', 'transition', 'Body'],
    ['slides', 'transition', 'Body', 'UNKNOWN'],
    ['slides', 'transition', 'Body', 'DISSOLVE', '--duration=-1'],
    ['slides', 'skip'],
    ['slides', 'skip', 'Body', 'maybe'],
    ['slides', 'skip', 'Body', 'on', 'extra'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
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

    for (const [action, tail] of [
      ['add', ['Label', 'text', 'Value']], ['set', ['Label', 'Value']],
      ['delete', ['Label#1:0']],
    ]) {
      const write = planFigmaCommand(['component', 'prop', action, '1:2', ...tail], { adapter });
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

test('Component Add Variant closes one policy-identical rollback-owned write', () => {
  const cli = planFigmaCommand([
    'component', 'add-variant', 'name:Button', 'State=Hover', '--from', 'State=Default', '--json',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'component', 'add-variant', 'name:Button', 'State=Hover', '--from=State=Default', '--json',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'component.add-variant');
});

test('Component Instantiate closes one policy-identical rollback-owned write', () => {
  const args = [
    'component', 'instantiate',
    'https://www.figma.com/design/FILEA/Test?node-id=2-1',
    '--parent', 'https://www.figma.com/design/FILEA/Test?node-id=2-2',
    '-x', '-12', '-y', '24', '--index', '1', '--name=Preview', '--json',
  ];
  const cli = planFigmaCommand(args, { adapter: 'cli' });
  const mcp = planFigmaCommand(args, { adapter: 'mcp' });
  assert.equal(cli.id, 'component.instantiate');
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
});

test('Component Create closes one policy-identical rollback-owned write', () => {
  const args = [
    'component', 'create', 'Preview',
    '--parent', 'https://www.figma.com/design/FILEA/Test?node-id=2-2',
    '--index', '1', '-w', '240', '-h', '120', '-x', '-12', '-y', '24', '--json',
  ];
  const cli = planFigmaCommand(args, { adapter: 'cli' });
  const mcp = planFigmaCommand(args, { adapter: 'mcp' });
  assert.equal(cli.id, 'component.create');
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
});

test('Component Swap closes one policy-identical one-shot verified write', () => {
  const args = [
    'component', 'swap',
    'https://www.figma.com/design/FILEA/Test?node-id=3-1',
    'https://www.figma.com/design/FILEA/Test?node-id=2-2',
    '--json',
  ];
  const cli = planFigmaCommand(args, { adapter: 'cli' });
  const mcp = planFigmaCommand(args, { adapter: 'mcp' });
  assert.equal(cli.id, 'component.swap');
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
});

test('Component Detach closes one policy-identical irreversible verified write', () => {
  const args = [
    'component', 'detach',
    'https://www.figma.com/design/FILEA/Test?node-id=3-1',
    '--name=Detached frame', '--json',
  ];
  const cli = planFigmaCommand(args, { adapter: 'cli' });
  const mcp = planFigmaCommand(args, { adapter: 'mcp' });
  assert.equal(cli.id, 'component.detach');
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
});

test('Component Overrides closes both action aliases as one policy-identical verified write', () => {
  for (const action of ['reset', 'remove']) {
    const args = [
      'component', 'overrides',
      'https://www.figma.com/design/FILEA/Test?node-id=3-1', action, '--json',
    ];
    const cli = planFigmaCommand(args, { adapter: 'cli' });
    const mcp = planFigmaCommand(args, { adapter: 'mcp' });
    assert.equal(cli.id, 'component.overrides');
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.target, mcp.target);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(cli.target.fileKey, 'FILEA');
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.confirmation, 'configured');
  }
});

test('Component Inventory closes one policy-identical bounded safe read', () => {
  const args = ['component', 'list', '--all-pages', '--json'];
  const cli = planFigmaCommand(args, { adapter: 'cli', fileKey: 'FILEA' });
  const mcp = planFigmaCommand(args, { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(cli.id, 'component.list');
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'read');
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.execution.timeout, 'long');
  assert.equal(cli.confirmation, 'none');

  const currentPage = planFigmaCommand(['component', 'list']);
  assert.equal(currentPage.execution.timeout, 'default');
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
    'var', 'create', '-cTokens', '-tfloat', '-v12', '-dSpacing', '--hidden=true',
    '--scopes=GAP', '--allow-duplicate', 'space/md',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'create', '--collection=Tokens', '--type=FLOAT', '--value=12',
    '--description=Spacing', '--hidden', 'true', '--scopes', 'GAP',
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
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '--scopes', 'ALL_SCOPES,GAP', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'COLOR', '--scopes', 'GAP', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Batch Creation closes one policy-identical non-retrying journaled batch', () => {
  const json = '[{"name":"color/accent","value":"#1234","description":"Accent","hidden":true,"scopes":["ALL_FILLS"]},{"name":"enabled","type":"BOOLEAN","value":true}]';
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
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","type":"FLOAT","scopes":["ALL_SCOPES","GAP"]}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","type":"COLOR","scopes":["GAP"]}]'],
    ['var', 'create-batch', '-c', 'Tokens', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Visualization closes one policy-identical non-retrying journaled canvas write', () => {
  const cli = planFigmaCommand(['var', 'visualize', '-mDark', 'Semantic Colors'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['var', 'visualize', '--mode=Dark', '--', 'Semantic Colors'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.execution.timeout, 'long');
  assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, 'var.visualize');
  for (const argv of [
    ['var', 'visualize', 'One', 'Two'], ['var', 'visualize', '--mode'],
    ['var', 'visualize', '-mLight', '-mDark'], ['var', 'visualize', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Token Presets close policy-identical non-retrying journaled scale writes', () => {
  for (const preset of ['spacing', 'radii']) {
    const cli = planFigmaCommand(['tokens', preset, '-cFoundation'], { adapter: 'cli' });
    const mcp = planFigmaCommand(['tokens', preset, '--collection=Foundation'], { adapter: 'mcp' });
    assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, `tokens.${preset}`);
  }
  for (const argv of [
    ['tokens', 'spacing', 'extra'], ['tokens', 'radii', '--collection'],
    ['tokens', 'spacing', '-cOne', '-cTwo'], ['tokens', 'radii', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Token Add closes one policy-identical non-retrying journaled write', () => {
  const cli = planFigmaCommand([
    'tokens', 'add', '-cFoundation', '-tFLOAT', '--allow-duplicate', '--', '-space/md', '-4',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'tokens', 'add', '--collection=Foundation', '--type=FLOAT', '--allow-duplicate',
    '--', '-space/md', '-4',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, 'tokens.add');
  for (const argv of [
    ['tokens', 'add', 'name'], ['tokens', 'add', 'name', 'value', 'extra'],
    ['tokens', 'add', '--collection'], ['tokens', 'add', '-cOne', '-cTwo', 'name', 'value'],
    ['tokens', 'add', '--future', 'private-value', 'name', 'value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Token Import closes one long policy-identical workspace-backed write', () => {
  const workspaceDir = resolve('/workspace');
  const cli = planFigmaCommand(['tokens', 'import', '-cTokens', 'tokens.json'], {
    adapter: 'cli', workspaceDir,
  });
  const mcp = planFigmaCommand([
    'tokens', 'import', '--collection=Tokens', '--', 'tokens.json',
  ], { adapter: 'mcp', workspaceDir });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.workspace, 'read'); assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never'); assert.equal(cli.execution.timeout, 'long');
  assert.equal(cli.confirmation, 'configured'); assert.equal(cli.audit.capability, 'tokens.import');
  assert.deepEqual(cli.argv, [
    'tokens', 'import', '--collection=Tokens', '--', join(workspaceDir, 'tokens.json'),
  ]);
  for (const argv of [
    ['tokens', 'import'],
    ['tokens', 'import', '--collection=A/B', 'tokens.json'],
    ['tokens', 'import', '--collection'],
    ['tokens', 'import', '--future', 'private-value', 'tokens.json'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Token Overlap closes one long policy-identical bounded safe read', () => {
  const cli = planFigmaCommand(['tokens', 'overlap', '--json', '-l25', 'Alpha', 'Beta'], {
    adapter: 'cli',
  });
  const mcp = planFigmaCommand([
    'tokens', 'overlap', '--limit=25', '--json', '--', 'Alpha', 'Beta',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'read'); assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.execution.timeout, 'long'); assert.equal(cli.confirmation, 'none');
  assert.equal(cli.execution.pluginDispatch, 'typed-read');
  assert.equal(cli.audit.capability, 'tokens.overlap');
  for (const argv of [
    ['tokens', 'overlap', 'One'], ['tokens', 'overlap', 'One', 'one'],
    ['tokens', 'overlap', '--limit', 'One', 'Two'],
    ['tokens', 'overlap', '--future', 'private-value', 'One', 'Two'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('CSS and DTCG close one long policy-identical exact Token Export read', () => {
  const cssCli = planFigmaCommand(['export', 'css', '12-34'], { adapter: 'cli' });
  const cssMcp = planFigmaCommand(['export', 'css', '12:34'], { adapter: 'mcp' });
  assert.equal(cssCli.allowed, true); assert.equal(cssMcp.allowed, true);
  assert.deepEqual(cssCli.argv, cssMcp.argv); assert.deepEqual(cssCli.effects, cssMcp.effects);
  assert.equal(cssCli.effects.figma, 'read'); assert.equal(cssCli.effects.workspace, 'none');
  assert.equal(cssCli.execution.retry, 'safe-read'); assert.equal(cssCli.execution.timeout, 'long');
  assert.equal(cssCli.confirmation, 'none'); assert.equal(cssCli.audit.capability, 'export.css');

  const workspaceDir = resolve('work', 'project');
  const output = join(workspaceDir, 'tokens.json');
  const dtcgCli = planFigmaCommand([
    'export', 'dtcg', 'tokens.json', '12-34', '--dialect=2025',
  ], { adapter: 'cli', workspaceDir });
  const dtcgMcp = planFigmaCommand([
    'export', 'dtcg', '--dialect', '2025', 'tokens.json', '12:34',
  ], { adapter: 'mcp', workspaceDir });
  assert.equal(dtcgCli.allowed, true); assert.equal(dtcgMcp.allowed, true);
  assert.deepEqual(dtcgCli.argv, dtcgMcp.argv); assert.deepEqual(dtcgCli.effects, dtcgMcp.effects);
  assert.deepEqual(dtcgCli.outputs, [{ role: 'dtcg-output', path: output }]);
  assert.equal(dtcgCli.effects.workspace, 'write'); assert.equal(dtcgCli.execution.retry, 'safe-read');
  assert.equal(dtcgCli.audit.capability, 'export.dtcg');

  const url = 'https://www.figma.com/design/FILE123/Test?node-id=12-34';
  assert.equal(planFigmaCommand(['export', 'dtcg', '--dialect=2025', url], {
    adapter: 'mcp',
  }).target.fileKey, 'FILE123');
  for (const argv of [
    ['export', 'css', '1:2', 'extra'],
    ['export', 'css', '--dialect', '2025'],
    ['export', 'dtcg', '--dialect', 'future'],
    ['export', 'dtcg', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Token Rebind closes one safe dry-run and one rollback-owned scoped write', () => {
  const dryCli = planFigmaCommand(['tokens', 'rebind', 'Theme', '-n12-34'], { adapter: 'cli' });
  const dryMcp = planFigmaCommand(['tokens', 'rebind', '--node', '12:34', '--', 'Theme'], { adapter: 'mcp' });
  assert.equal(dryCli.allowed, true); assert.equal(dryMcp.allowed, true);
  assert.deepEqual(dryCli.argv, dryMcp.argv); assert.deepEqual(dryCli.effects, dryMcp.effects);
  assert.equal(dryCli.effects.figma, 'read'); assert.equal(dryCli.execution.retry, 'safe-read');
  assert.equal(dryCli.execution.timeout, 'long'); assert.equal(dryCli.confirmation, 'none');
  assert.equal(dryCli.audit.capability, 'tokens.rebind');

  const apply = planFigmaCommand(['tokens', 'rebind', 'Theme', '--node', '12:34', '--apply'], {
    adapter: 'mcp',
  });
  assert.equal(apply.allowed, true); assert.equal(apply.effects.figma, 'write');
  assert.equal(apply.execution.retry, 'never'); assert.equal(apply.confirmation, 'configured');
  for (const argv of [
    ['tokens', 'rebind', 'Theme'],
    ['tokens', 'rebind', 'Theme', '--page', '--apply'],
    ['tokens', 'rebind', 'Theme', '--node', '1:2', '--page'],
    ['tokens', 'rebind', '--future', 'private-value', '--node', '1:2', 'Theme'],
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

test('Variable Metadata Update Batch closes one policy-identical reverse-rollback write', () => {
  const json = JSON.stringify([
    { variable: 'space/md', collection: 'Tokens', description: 'Medium' },
    { variable: 'space/lg', collection: 'Tokens', hidden: true, scopes: ['GAP'] },
  ]);
  const cli = planFigmaCommand(['var', 'update-batch', json], { adapter: 'cli' });
  const mcp = planFigmaCommand(['var', 'update-batch', '--', json], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'var.update-batch');
  for (const argv of [
    ['var', 'update-batch', '[]'],
    ['var', 'update-batch', '[{"variable":"x"}]'],
    ['var', 'update-batch', '[{"variable":"x","hidden":"true"}]'],
    ['var', 'update-batch', '[{"variable":"x","description":"a"},{"variable":"x","description":"b"}]'],
    ['var', 'update-batch', '--future', 'private-value'],
  ]) assert.equal(planFigmaCommand(argv).allowed, false, argv.join(' '));
});

test('Variable Set Value Batch closes one policy-identical best-effort rollback write', () => {
  const json = JSON.stringify([
    { variable: 'space/md', collection: 'Tokens', mode: 'Light', value: 20 },
    { variable: 'space/lg', mode: 'Dark', alias: 'space/md' },
  ]);
  const cli = planFigmaCommand(['var', 'set-value-batch', json], { adapter: 'cli' });
  const mcp = planFigmaCommand(['var', 'set-value-batch', '--', json], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.audit.capability, 'var.set-value-batch');
  assert.deepEqual(cli.mutationPolicy, { rollback: 'best-effort-rollback' });
  for (const argv of [
    ['var', 'set-value-batch', '[]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light"}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1,"alias":"y"}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1},{"variable":"x","mode":"Light","value":2}]'],
    ['var', 'set-value-batch', '--future', 'private-value'],
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

test('Node typography bind and unbind close policy-identical non-retrying writes', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [['font','bind','1-2','font-size','type/size','--start','1','--end','4','-c','Fixture'],
      ['font','bind','--collection=Fixture','--end=4','--start=1','--','1:2','fontSize','type/size'], 'font.bind'],
    [['font','unbind','1:2','line-height'], ['font','unbind','--','1:2','lineHeight'], 'font.unbind'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv); assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(cli.effects.figma, 'write'); assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.audit.capability, action);
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

test('Layout Guide mutations close policy-identical non-retrying CLI/MCP writes', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [
      ['grid', 'set', '10-3', '--columns=12', '--gutter=20'],
      ['grid', 'set', '-g20', '-c12', '--', '10:3'],
      'grid.set',
    ],
    [['grid', 'clear', '10-3'], ['grid', 'clear', '--', '10:3'], 'grid.clear'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.audit.capability, action);
  }
});

test('Analyze census actions close policy-identical safe current-page reads', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [['analyze', 'colors'], ['analyze', 'colors'], 'analyze.colors'],
    [['analyze', 'type', '--json'], ['analyze', 'typography', '--json'], 'analyze.typography'],
    [['analyze', 'spacing'], ['analyze', 'spacing'], 'analyze.spacing'],
    [['analyze', 'clusters'], ['analyze', 'clusters'], 'analyze.clusters'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'read');
    assert.equal(cli.effects.editor, 'read');
    assert.equal(cli.execution.retry, 'safe-read');
    assert.equal(cli.audit.capability, action);
  }
});

test('Dev Resource Read closes one policy-identical CLI/MCP safe read', () => {
  const cli = planFigmaCommand(['dev', 'list', '10-3'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['dev', 'list', '--', '10:3'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.audit.capability, 'dev.list');

  const selection = planFigmaCommand(['dev', 'list'], { adapter: 'mcp' });
  assert.equal(selection.effects.editor, 'read');
});

test('Dev Resource mutations close policy-identical non-retrying writes', () => {
  for (const [cliArgv, mcpArgv, action] of [
    [
      ['dev', 'link', '10-3', 'https://example.test/storybook', '--name', 'Storybook'],
      ['dev', 'link', '--name=Storybook', '--', '10:3', 'https://example.test/storybook'],
      'dev.link',
    ],
    [
      ['dev', 'unlink', '10-3', 'https://example.test/storybook'],
      ['dev', 'unlink', '--', '10:3', 'https://example.test/storybook'],
      'dev.unlink',
    ],
    [
      ['dev', 'edit', '10-3', 'https://example.test/old', 'https://example.test/new', '-n', 'Docs'],
      ['dev', 'edit', '--name=Docs', '--', '10:3', 'https://example.test/old', 'https://example.test/new'],
      'dev.edit',
    ],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.audit.capability, action);
  }
});

test('Section Inventory closes one policy-identical current-page safe read', () => {
  const cli = planFigmaCommand(['section', 'list'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'list', '--'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.audit.capability, 'section.list');
});

test('Section Fit closes one policy-identical non-retrying geometry write', () => {
  const cli = planFigmaCommand(['section', 'fit', '10-3', '--pad=32'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'fit', '--pad', '32', '10:3'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'section.fit');
});

test('Section Arrange closes one policy-identical non-retrying geometry write', () => {
  const cli = planFigmaCommand([
    'section', 'arrange', '10-3', '--cols=2', '--gap=10', '--pad=20', '--group-rows',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'section', 'arrange', '--group-rows', '--pad', '20', '-g10', '-c2', '10:3',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'section.arrange');
});

test('Section Add closes one policy-identical non-retrying batch write', () => {
  const cli = planFigmaCommand(['section', 'add', '10-3', '11-1,11:2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'add', '--', '10:3', '11:1,11-2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'section.add');
});

test('Section Create closes one policy-identical current-page batch write', () => {
  const cli = planFigmaCommand(['section', 'create', 'Components', '11-1,11:2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'create', 'Components', '11:1,11-2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'section.create');
});

test('Annotation Category Inventory closes one policy-identical file safe read', () => {
  const cli = planFigmaCommand(['annotate', 'categories'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'categories', '--'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.audit.capability, 'annotate.categories');
});

test('Annotation Read closes one policy-identical node-or-selection safe read', () => {
  const cli = planFigmaCommand(['annotate', 'list', '1-2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'list', '--', '1:2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.audit.capability, 'annotate.list');

  const selection = planFigmaCommand(['annotate', 'list'], { adapter: 'mcp' });
  assert.equal(selection.effects.editor, 'read');
});

test('Annotation Clear closes one policy-identical non-retrying node write', () => {
  const cli = planFigmaCommand(['annotate', 'clear', '1-2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'clear', '1:2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'annotate.clear');
});

test('Annotation Remove closes one policy-identical non-retrying index mutation', () => {
  const cli = planFigmaCommand(['annotate', 'remove', '1-2', '00'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'remove', '1:2', '0'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'annotate.remove');
});

test('Annotation Edit closes one policy-identical non-retrying patch mutation', () => {
  const cli = planFigmaCommand([
    'annotate', 'edit', '1-2', '00', '--text=New', '--properties=width',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'annotate', 'edit', '--properties=width', '--text=New', '1:2', '0',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'annotate.edit');
});

test('Annotation Category mutations close policy-identical non-retrying file writes', () => {
  for (const [argv, action] of [
    [['annotate', 'category-add', 'Ready', '--color=green'], 'annotate.category-add'],
    [['annotate', 'category-edit', 'Review', '--label=Ready'], 'annotate.category-edit'],
    [['annotate', 'category-remove', 'Review'], 'annotate.category-remove'],
  ]) {
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.effects.editor, 'none');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.audit.capability, action);
  }
});

test('Annotation Add closes node/query policy and declares only real editor-context reads', () => {
  const cli = planFigmaCommand([
    'annotate', 'add', '--node=1-1', '--category=Review', '--', 'New',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'annotate', 'add', '--category=Review', '--node=1:1', '--', 'New',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.audit.capability, 'annotate.add');

  const query = planFigmaCommand([
    'annotate', 'add', '--query=Card', '--', 'New',
  ], { adapter: 'mcp' });
  assert.equal(query.effects.editor, 'read');
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
  const workspaceDir = resolve('/work');
  for (const literal of ['--print-browser-capture', '--structural-gate', '--verify']) {
    const plan = planFigmaCommand(['render', '--', literal], { workspaceDir });
    assert.equal(plan.allowed, true, literal);
    assert.equal(plan.effects.figma, 'write', literal);
    assert.equal(plan.target.kind, 'plugin-file', literal);
    assert.equal(plan.execution.timeout, 'long', literal);
    assert.equal(plan.execution.retry, 'never', literal);
    assert.deepEqual(plan.outputs, [], literal);
  }

  const tokenLiteral = planFigmaCommand(['tokens', 'sync', '--', '--apply'], {
    workspaceDir,
  });
  assert.equal(tokenLiteral.effects.figma, 'read');
  assert.equal(tokenLiteral.confirmation, 'none');
  assert.deepEqual(tokenLiteral.argv, ['tokens', 'sync', '--', join(workspaceDir, '--apply')]);
  assert.equal(planFigmaCommand(['tokens', 'sync', '--apply', 'tokens.json'], {
    workspaceDir,
  }).effects.figma, 'write');

  const gradientLiteral = planFigmaCommand(['gradient', 'extract', '--', '--apply-to'], {
    workspaceDir,
  });
  assert.equal(gradientLiteral.effects.figma, 'none');
  assert.equal(gradientLiteral.target.kind, 'none');
  assert.deepEqual(gradientLiteral.argv, ['gradient', 'extract', '--', join(workspaceDir, '--apply-to')]);
  assert.equal(planFigmaCommand([
    'gradient', 'extract', 'hero.png', '--apply-to', '1:2',
  ], { workspaceDir }).effects.figma, 'write');

  assert.equal(planFigmaCommand(['spec', '--', '--check']).target.kind, 'none');
  assert.equal(planFigmaCommand(['spec', 'Button', '--check', '1:2']).target.kind, 'plugin-file');
  assert.equal(planFigmaCommand(['verify-build', '--', '--node'], {
    workspaceDir,
  }).target.kind, 'none');
  assert.equal(planFigmaCommand(['verify-build', '.', '--node', '1:2'], {
    workspaceDir,
  }).target.kind, 'plugin-file');

  const outputLiteral = planFigmaCommand(['export', 'node', '1:2', '--', '--output'], {
    workspaceDir,
  });
  assert.equal(outputLiteral.allowed, false);
  assert.deepEqual(outputLiteral.outputs, []);

  const networkLiteral = planFigmaCommand([
    'kit', 'init', '.', '--', '--storybook=https://example.test/private',
  ], { workspaceDir });
  assert.equal(networkLiteral.effects.network, 'none');
  assert.equal(planFigmaCommand([
    'map', 'storybook', '--output', 'map.json', 'https://example.test/storybook',
  ], { workspaceDir }).effects.network, 'read');
  assert.equal(planFigmaCommand([
    'map', 'storybook', '--', '--output=https://example.test/literal',
  ], { workspaceDir }).effects.network, 'none');

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
      figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'none',
    }, args.join(' '));
    assert.equal(plan.target.kind, 'none', args.join(' '));
  }
});

test('short-attached Legacy option values keep Commander meaning during path planning', () => {
  const workspaceDir = resolve('/work');
  const exportPlan = planFigmaCommand([
    'export', 'node', '1:2', '-onode.png', '-fpng', '-s2',
  ], { workspaceDir });
  assert.equal(exportPlan.allowed, true);
  assert.deepEqual(exportPlan.argv, [
    'export', 'node', '1:2', '-o', join(workspaceDir, 'node.png'),
  ]);
  assert.equal(exportPlan.outputs[0].path, join(workspaceDir, 'node.png'));

  const specPlan = planFigmaCommand([
    'spec', 'Button', '-fDESIGN.md',
  ], { workspaceDir });
  assert.equal(specPlan.allowed, true);
  assert.deepEqual(specPlan.argv, [
    'spec', '--file', join(workspaceDir, 'DESIGN.md'), '--tolerance', '2', '--', 'Button',
  ]);
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

test('Node Delete closes one policy-identical non-retrying batch without losing URL targeting', () => {
  const url = 'https://www.figma.com/design/FILEA/Delete-Lab?node-id=12-34';
  const mcp = planFigmaCommand(['node', 'delete', url, '56-78'], { adapter: 'mcp' });
  const cli = planFigmaCommand(['node', 'delete', url, '56:78'], { adapter: 'cli' });
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(mcp.argv, ['node', 'delete', '12:34', '56:78']);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.delete');
  for (const args of [
    ['node', 'delete'],
    ['node', 'delete', '1:2', '1-2'],
    ['node', 'delete', '--future'],
    ['node', 'delete', 'not-a-node'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node to-component closes one policy-identical irreversible batch', () => {
  const url = 'https://www.figma.com/design/FILEA/Conversion-Lab?node-id=12-34';
  const mcp = planFigmaCommand(['node', 'to-component', url, '56-78'], { adapter: 'mcp' });
  const cli = planFigmaCommand(['node', 'to-component', url, '56:78'], { adapter: 'cli' });
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(mcp.argv, ['node', 'to-component', '12:34', '56:78']);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.to-component');
  for (const args of [
    ['node', 'to-component'],
    ['node', 'to-component', '1:2', '1-2'],
    ['node', 'to-component', '--future'],
    ['node', 'to-component', 'not-a-node'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node Duplicate closes one policy-identical rollback-owned write', () => {
  const sourceUrl = 'https://www.figma.com/design/FILEA/Duplicate-Lab?node-id=12-34';
  const parentUrl = 'https://www.figma.com/design/FILEA/Duplicate-Lab?node-id=56-78';
  const mcp = planFigmaCommand([
    'node', 'duplicate', sourceUrl, '--parent', parentUrl, '--index', '2',
    '--name=Copy', '--offset-x=-20', '--offset-y=10', '--json',
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand([
    'node', 'duplicate', sourceUrl, '--parent', parentUrl, '--index=2',
    '--name', 'Copy', '--offset-x', '-20', '--offset-y', '10', '--json',
  ], { adapter: 'cli' });
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.duplicate');
  for (const args of [
    ['node', 'duplicate'],
    ['node', 'duplicate', '1:2', '1-2'],
    ['node', 'duplicate', '1:2', '--index', '-1'],
    ['node', 'duplicate', '1:2', '--future'],
    ['node', 'duplicate', 'not-a-node'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node Rename closes one policy-identical rollback-owned write', () => {
  const url = 'https://www.figma.com/design/FILEA/Rename-Lab?node-id=12-34';
  const mcp = planFigmaCommand(['node', 'rename', url, '--', '-new-name'], {
    adapter: 'mcp',
  });
  const cli = planFigmaCommand(['node', 'rename', url, '--', '-new-name'], {
    adapter: 'cli',
  });
  const { adapter: _mcpAdapter, ...mcpPolicy } = mcp;
  const { adapter: _cliAdapter, ...cliPolicy } = cli;
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(cliPolicy, mcpPolicy);
  assert.deepEqual(mcp.argv, ['node', 'rename', '12:34', '--', '-new-name']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.rename');
  for (const args of [
    ['node', 'rename'],
    ['node', 'rename', '1:2'],
    ['node', 'rename', '1:2', 'After', 'extra'],
    ['node', 'rename', '1:2', '--future'],
    ['node', 'rename', 'not-a-node', 'After'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node Resize closes one policy-identical rollback-owned write', () => {
  const url = 'https://www.figma.com/design/FILEA/Resize-Lab?node-id=12-34';
  const mcp = planFigmaCommand(['node', 'resize', url, '--', '-20', 'hug'], { adapter: 'mcp' });
  const cli = planFigmaCommand(['node', 'resize', url, '--', '-20', 'hug'], { adapter: 'cli' });
  const { adapter: _mcpAdapter, ...mcpPolicy } = mcp;
  const { adapter: _cliAdapter, ...cliPolicy } = cli;
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(cliPolicy, mcpPolicy);
  assert.deepEqual(mcp.argv, ['node', 'resize', '12:34', '--', '-20', 'hug']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.resize');
  for (const args of [
    ['node', 'resize'], ['node', 'resize', '1:2', '20'],
    ['node', 'resize', '1:2', '20', '30', 'extra'],
    ['node', 'resize', '1:2', 'wide', '30'], ['node', 'resize', 'not-a-node', '20', '30'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node Set closes one policy-identical journaled multi-property write', () => {
  const url = 'https://www.figma.com/design/FILEA/Set-Lab?node-id=12-34';
  const mcp = planFigmaCommand([
    'node', 'set', '--name', 'Card', url, '--opacity=.5',
    '--fill=var:brand/base', '--collection', 'Tokens',
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand([
    'node', 'set', url, '--fill', 'var:brand/base', '--opacity', '0.5',
    '--name=Card', '--collection=Tokens',
  ], { adapter: 'cli' });
  const { adapter: _mcpAdapter, ...mcpPolicy } = mcp;
  const { adapter: _cliAdapter, ...cliPolicy } = cli;
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(cliPolicy, mcpPolicy);
  assert.deepEqual(mcp.argv, [
    'node', 'set', '12:34', '--fill=var:brand/base', '--opacity=0.5',
    '--name=Card', '--collection=Tokens',
  ]);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.set');
  for (const args of [
    ['node', 'set'], ['node', 'set', '1:2'],
    ['node', 'set', '1:2', '--width=20'],
    ['node', 'set', '1:2', '--visible=perhaps'],
    ['node', 'set', '1:2', '--fill=#fff'],
    ['node', 'set', '1:2', '--batch=[]'],
    ['node', 'set', 'not-a-node', '--name=Card'],
    ['node', 'set', '1:2', '--name=Card', '--future=value'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node Set Fill closes one policy-identical rollback-owned write', () => {
  const url = 'https://www.figma.com/design/FILEA/Fill-Lab?node-id=12-34';
  const mcp = planFigmaCommand(['node', 'set-fill', url, '#aBcDeF'], { adapter: 'mcp' });
  const cli = planFigmaCommand(['node', 'set-fill', url, 'ABCDEF'], { adapter: 'cli' });
  const { adapter: _mcpAdapter, ...mcpPolicy } = mcp;
  const { adapter: _cliAdapter, ...cliPolicy } = cli;
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(cliPolicy, mcpPolicy);
  assert.deepEqual(mcp.argv, ['node', 'set-fill', '12:34', '#ABCDEF']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.set-fill');
  for (const args of [
    ['node', 'set-fill'],
    ['node', 'set-fill', '1:2'],
    ['node', 'set-fill', '1:2', '#fff'],
    ['node', 'set-fill', '1:2', 'var:'],
    ['node', 'set-fill', '1:2', '#FFFFFF', 'extra'],
    ['node', 'set-fill', 'not-a-node', '#FFFFFF'],
  ]) assert.equal(planFigmaCommand(args).allowed, false, args.join(' '));
});

test('Node Set Image closes one policy-identical workspace-backed write', () => {
  const base = resolve('work', 'image-plan');
  const file = join(base, 'pixel.png');
  const url = 'https://www.figma.com/design/FILEA/Image-Lab?node-id=12-34';
  const mcp = planFigmaCommand([
    'node', 'set-image', '--scale', 'crop', url, 'pixel.png',
  ], { adapter: 'mcp', workspaceDir: base });
  const cli = planFigmaCommand([
    'node', 'set-image', url, 'pixel.png', '--scale=CROP',
  ], { adapter: 'cli', workspaceDir: base });
  const { adapter: _mcpAdapter, ...mcpPolicy } = mcp;
  const { adapter: _cliAdapter, ...cliPolicy } = cli;
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(cliPolicy, mcpPolicy);
  assert.deepEqual(mcp.argv, [
    'node', 'set-image', '12:34', '--scale', 'CROP', '--', file,
  ]);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(mcp.effects, {
    figma: 'write', editor: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.equal(mcp.confirmation, 'configured');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.audit.capability, 'node.set-image');
  for (const args of [
    ['node', 'set-image'],
    ['node', 'set-image', '1:2'],
    ['node', 'set-image', '1:2', 'pixel.png', 'extra'],
    ['node', 'set-image', '1:2', 'pixel.png', '--future'],
    ['node', 'set-image', 'not-a-node', 'pixel.png'],
  ]) assert.equal(planFigmaCommand(args, { workspaceDir: base }).allowed, false, args.join(' '));
});

test('Node Binding Facts use the closed typed-read dispatch in both Adapters', () => {
  const cli = planFigmaCommand(['node', 'bindings', '12:34', '--json'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['node', 'bindings', '--json', '12-34'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.execution.pluginDispatch, 'typed-read');
  assert.equal(cli.effects.figma, 'read');
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

  const remoteImport = planFigmaCommand(['import', payloadUrl]);
  assert.equal(remoteImport.target.fileKey, null);
  assert.equal(remoteImport.target.source, 'not-applicable',
    'a remote Storybook source is payload and does not need a Figma target');

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
  assert.equal(planFigmaCommand(['render', '--prop-reference', 'Text']).target.kind, 'none');
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

test('CLI and MCP decide identical policy for every Design Link action', () => {
  const cases = [
    {
      argv: ['link', 'inspect', '1:2', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'read', editor: 'none', workspace: 'read', network: 'none', shared: 'none' },
      confirmation: 'none',
      retry: 'safe-read',
    },
    {
      argv: ['link', 'set', '1:2', 'ui.button', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'write', editor: 'none', workspace: 'write', network: 'none', shared: 'none' },
      confirmation: 'configured',
      retry: 'never',
    },
    {
      argv: ['link', 'list', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'none', editor: 'none', workspace: 'read', network: 'none', shared: 'none' },
      confirmation: 'none',
      retry: 'never',
    },
    {
      argv: ['link', 'configure', '--tokens', 'tokens.json', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'none', editor: 'none', workspace: 'write', network: 'none', shared: 'none' },
      confirmation: 'none',
      retry: 'never',
    },
    ...['status', 'context'].map((action) => ({
      argv: ['link', action, 'ui.button', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'read', editor: 'none', workspace: 'read', network: 'none', shared: 'none' },
      confirmation: 'none',
      retry: 'never',
    })),
    {
      argv: ['link', 'accept', 'ui.button', '--manifest', '/work/figma-bridge.json'],
      effects: { figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none' },
      confirmation: 'none',
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
  const workspaceDir = resolve('/work');
  const plan = planFigmaCommand(['link', 'inspect', '1:2'], {
    workspaceDir,
    workspaceIO: {
      authorizePath(path, intent) { intents.push({ path, ...intent }); },
    },
  });
  assert.equal(plan.allowed, true);
  assert.deepEqual(intents, [{
    path: join(workspaceDir, 'figma-bridge.json'),
    access: 'read-optional',
    role: 'design-link-manifest',
    kind: 'file',
  }]);
});

test('CLI and MCP decide identical policy and accepted outcomes for Design Contracts', () => {
  const cases = [
    {
      argv: ['contract', 'capture', 'ui.button', '--manifest', '/work/figma-bridge.json', '--file', '/work/ui.button.json'],
      effects: { figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none' },
      okExitCodes: [0],
    },
    {
      argv: ['contract', 'check', 'ui.button', '--manifest', '/work/figma-bridge.json', '--file', '/work/ui.button.json'],
      effects: { figma: 'read', editor: 'none', workspace: 'read', network: 'none', shared: 'none' },
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
  const workspaceDir = resolve('/work/project');
  const manifestPath = join(workspaceDir, 'figma-bridge.json');
  const plan = planFigmaCommand(['link', 'context', 'screen.settings'], {
    workspaceDir,
    workspaceIO: {
      authorizePath(path, intent) {
        authorizedPaths++;
        assert.equal(path, manifestPath);
        assert.equal(intent.role, 'design-link-manifest');
      },
    },
    registryFileKey(argv) {
      targetResolutions++;
      assert.deepEqual(argv.slice(-2), ['--manifest', manifestPath]);
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
  assert.deepEqual(argv(['export', 'node', '1:2', '--output=shot.png']).slice(-1), [inWorkspace('shot.png')]);
  assert.deepEqual(argv(['export', 'node-json', '1:2', '--output=facts.json']).slice(-1), [`--output=${inWorkspace('facts.json')}`]);
  assert.deepEqual(argv(['export', 'node-json', '1:2', '-o=facts.json']).slice(-1), [`-o=${inWorkspace('facts.json')}`]);
  assert.deepEqual(argv(['export', 'node-json', '1:2']), ['export', 'node-json', '1:2']);
  assert.deepEqual(argv(['export', 'video', '1:2', '--format', 'gif']).slice(-2), ['-o', inWorkspace('video.gif')]);
  assert.deepEqual(argv(['map', 'storybook', 'url']), [
    'map', 'storybook', '--output', inWorkspace('figma-map.json'), '--', inWorkspace('url'),
  ]);
  assert.deepEqual(argv(['link', 'list']).slice(-2), ['--manifest', inWorkspace('figma-bridge.json')]);
  assert.deepEqual(argv(['link', 'set', '1:2', 'ui.button', '--manifest=design/links.json']).slice(-1), [
    `--manifest=${inWorkspace('design', 'links.json')}`,
  ]);
  assert.deepEqual(
    argv(['link', 'accept', 'screen.home', '--compare', 'shots/home.jpg']),
    ['link', 'accept', 'screen.home', '--compare', inWorkspace('shots', 'home.jpg'), '--manifest', inWorkspace('figma-bridge.json')],
  );
  assert.deepEqual(
    argv(['verify-build', '.', '--compare', 'shot.png', '--fidelity-ledger', 'facts.json',
      '--browser-capture=captures/screen.json']),
    ['verify-build', base, '--compare', inWorkspace('shot.png'),
      '--fidelity-ledger', inWorkspace('facts.json'),
      `--browser-capture=${inWorkspace('captures', 'screen.json')}`],
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
  assert.deepEqual(argv(['node', 'set-image', '1:2', 'photo.png']), [
    'node', 'set-image', '1:2', '--scale', 'FILL', '--', inWorkspace('photo.png'),
  ]);
  assert.deepEqual(argv(['tokens', 'sync', 'tokens.json', '--lockfile', '.tokens.lock.json']), [
    'tokens', 'sync', inWorkspace('tokens.json'), '--lockfile', inWorkspace('.tokens.lock.json'),
  ]);
  assert.deepEqual(argv(['spec', 'Button', '--file=design/DESIGN.md']), [
    'spec', '--file', inWorkspace('design', 'DESIGN.md'), '--tolerance', '2', '--', 'Button',
  ]);
  assert.deepEqual(argv(['motion', 'apply', 'motion.json']), ['motion', 'apply', inWorkspace('motion.json')]);
  assert.deepEqual(argv(['history', 'diff', 'latest', 'live', '--changelog', 'changes.md']), [
    'history', 'diff', 'latest', 'live', '--changelog', inWorkspace('changes.md'),
  ]);
  assert.deepEqual(argv(['export', 'dtcg', 'tokens.json']), ['export', 'dtcg', inWorkspace('tokens.json')]);
  assert.deepEqual(argv(['export', 'dtcg', '12:34']), ['export', 'dtcg', '12:34']);
});

test('catalog reports workspace, network and shared-state effects independently from Figma effects', () => {
  assert.deepEqual(planFigmaCommand(['spec', 'Button', '--file', 'DESIGN.md'], { workspaceDir: '/work' }).effects, {
    figma: 'none', editor: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.equal(planFigmaCommand(['tokens', 'sync', 'tokens.json'], { workspaceDir: '/work' }).effects.workspace, 'write');
  assert.equal(planFigmaCommand(['history', 'snapshot']).effects.shared, 'write');
  assert.equal(planFigmaCommand(['history', 'snapshot', '--json']).effects.shared, 'none');
  assert.equal(planFigmaCommand(['history', 'list']).effects.shared, 'read');
  assert.deepEqual(planFigmaCommand(['api', 'setup']).effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'write',
  });
  assert.deepEqual(planFigmaCommand(['api', 'index']).effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'write',
  });
  assert.deepEqual(planFigmaCommand(['api', 'context']).effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'read',
  });
  assert.deepEqual(planFigmaCommand(['api', 'SceneNode']).effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'read',
  });
  const apiPlan = planFigmaCommand(['api', 'setup']);
  assert.match(apiPlan.audit.materialVersion, /^figma-plugin-typings-1\.133\.0-[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(apiPlan.audit), /https?:|node_modules|figma-api[\\/]/i);
  assert.deepEqual(planFigmaCommand(['api']).effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'none',
  });
  assert.equal(planFigmaCommand(['map', 'storybook', 'http://localhost:6006']).effects.network, 'read');
  assert.equal(planFigmaCommand(['map', 'storybook', './storybook-static']).effects.network, 'none');
  assert.equal(planFigmaCommand(['import', 'https://storybook.example.com']).effects.network, 'read');
  assert.deepEqual(
    planFigmaCommand(['import', './tokens.css', '--print-context'], { workspaceDir: '/work' }).effects,
    { figma: 'none', editor: 'none', workspace: 'read', network: 'none', shared: 'none' },
  );
  assert.equal(
    planFigmaCommand(['import', './tokens.css', '--print-context'], { workspaceDir: '/work' })
      .target.kind,
    'none',
  );
  assert.deepEqual(
    planFigmaCommand([
      'import', './tokens.css', '--print-context', '--save', './converted.md',
    ], { workspaceDir: '/work' }).effects,
    { figma: 'none', editor: 'none', workspace: 'write', network: 'none', shared: 'none' },
  );
  assert.equal(planFigmaCommand(['kit', 'init', '.', '--storybook=https://storybook.example.com']).effects.network, 'read');
  assert.deepEqual(planFigmaCommand(['link', 'set', '1:2', 'ui.button'], { workspaceDir: '/work' }).effects, {
    figma: 'write', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'list'], { workspaceDir: '/work' }).effects, {
    figma: 'none', editor: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'accept', 'ui.button'], { workspaceDir: '/work' }).effects, {
    figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'context', 'ui.button'], { workspaceDir: '/work' }).effects, {
    figma: 'read', editor: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['link', 'configure', '--tokens', 'tokens.json'], { workspaceDir: '/work' }).effects, {
    figma: 'none', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
  });
  assert.deepEqual(planFigmaCommand(['export', 'node-json', '1:2', '-o', 'facts.json'], { workspaceDir: '/work' }).effects, {
    figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
  });
});

test('catalog classifies editor selection, viewport, focus, and current-page effects explicitly', () => {
  const cases = [
    { argv: ['canvas', 'pages'], effect: 'read' },
    { argv: ['canvas', 'page', 'Components'], effect: 'write' },
    { argv: ['canvas', 'page-create', 'Draft'], effect: 'write' },
    { argv: ['canvas', 'page-create', '--no-switch', 'Draft'], effect: 'none' },
    { argv: ['create', 'frame', 'Frame'], effect: 'write' },
    { argv: ['sizes', '1:2'], effect: 'write' },
    { argv: ['combos', '--dry-run'], effect: 'read' },
    { argv: ['combos', '1:2', '--dry-run'], effect: 'none' },
    { argv: ['var', 'visualize', 'Collection'], effect: 'write' },
    { argv: ['gradient', 'mesh', '#ffffff'], effect: 'write' },
    { argv: ['slides', 'inspect'], effect: 'read' },
    { argv: ['slides', 'create', 'Intro'], effect: 'write' },
    { argv: ['jam', 'sticky', 'Note'], effect: 'write' },
    { argv: ['jam', 'board'], effect: 'read' },
    { argv: ['node', 'bindings'], effect: 'read' },
    { argv: ['node', 'bindings', '1:2'], effect: 'none' },
    { argv: ['link', 'inspect'], effect: 'read' },
    { argv: ['link', 'inspect', '1:2'], effect: 'none' },
    { argv: ['verify'], effect: 'read' },
    { argv: ['verify', '1:2'], effect: 'none' },
    { argv: ['pin', 'left'], effect: 'read' },
    { argv: ['pin', 'left', '--node', '1:2'], effect: 'none' },
  ];
  for (const { argv, effect } of cases) {
    const plan = planFigmaCommand(argv);
    assert.equal(plan.allowed, true, argv.join(' '));
    assert.equal(plan.effects.editor, effect, argv.join(' '));
    if (effect === 'write') assert.equal(plan.execution.retry, 'never', argv.join(' '));
  }
});

test('API reference plans expose only private-state effects and stable material provenance', () => {
  const setup = planFigmaCommand(['api', 'setup']);
  const lookup = planFigmaCommand(['api', 'show', 'FrameNode']);
  assert.deepEqual(setup.effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'write',
  });
  assert.deepEqual(lookup.effects, {
    figma: 'none', editor: 'none', workspace: 'none', network: 'none', shared: 'read',
  });
  assert.equal(setup.audit.materialVersion, lookup.audit.materialVersion);
  assert.match(setup.audit.materialVersion, /^figma-plugin-typings-1\.133\.0-[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify([setup.audit, lookup.audit]), /https?:|node_modules|figma-api[\\/]/i);
});

test('cross-Adapter conformance keeps policy identical while migration exposure stays explicit', () => {
  const cases = [
    ['export', 'code-spec', '1:2'],
    ['verify', '1:2', '--base64'],
    ['inspect', '1:2', '--format', 'yaml'],
    ['link', 'inspect', '1:2'],
    ['link', 'set', '1:2', 'ui.button'],
    ['link', 'list'],
    ['link', 'configure'],
    ['link', 'status', 'ui.button'],
    ['link', 'accept', 'ui.button'],
    ['link', 'context', 'ui.button'],
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
    if (['export.assets', 'export.code-spec', 'history.snapshot', 'history.list', 'history.diff', 'inspect', 'link.inspect', 'link.set', 'link.list', 'link.configure', 'link.status', 'link.accept', 'link.context', 'verify'].includes(mcp.id)) assert.equal(cliAllowed, mcpAllowed);
    else assert.equal(cliAllowed, false);
  }
  assert.equal(planFigmaCommand(['export', 'assets', '1:2']).execution.mode, 'tracked-job');
  assert.equal(planFigmaCommand(['future-command']).allowed, false);
});

test('Create Frame owns one canonical cross-Adapter write Plan', () => {
  const variants = [
    ['create', 'frame', 'Card'],
    ['create', 'frame', 'Card', '-w', '100', '-h', '100', '-y', '0'],
    ['create', 'frame', '--height=100', '--width=100', 'Card'],
  ];
  const plans = variants.map((argv) => planFigmaCommand(argv, {
    adapter: 'mcp', fileKey: 'FILE_A',
  }));
  for (const plan of plans) {
    const cli = planFigmaCommand(plan.argv, { adapter: 'cli', fileKey: 'FILE_A' });
    assert.equal(plan.allowed, true);
    assert.equal(cli.allowed, true);
    assert.equal(plan.id, 'create.frame');
    assert.deepEqual(plan.argv, ['create', 'frame', 'Card', '--width=100', '--height=100', '--y=0']);
    assert.deepEqual(plan.effects, cli.effects);
    assert.deepEqual(plan.target, cli.target);
    assert.equal(plan.execution.retry, 'never');
  }
  assert.equal(planFigmaCommand(['create', 'frame'], { adapter: 'mcp' }).allowed, false);
  assert.equal(planFigmaCommand(['create', 'frame', 'Card', '--future'], { adapter: 'mcp' }).allowed, false);
});

test('solid Shape creation owns canonical cross-Adapter write Plans', () => {
  const cases = [
    [['create', 'rectangle', 'Card', '--fill', '#abc'], 'create.rect', ['create', 'rect', 'Card', '--fill=#AABBCC']],
    [['create', 'circle', '--width', '80'], 'create.ellipse', ['create', 'ellipse', '--width=80']],
    [['create', 'polygon', '--points', '6'], 'create.polygon', ['create', 'polygon', '--points=6']],
    [['create', 'star', '--inner-radius', '.25'], 'create.star', ['create', 'star', '--inner-radius=0.25']],
  ];
  for (const [argv, id, canonical] of cases) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILE_A' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILE_A' });
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.equal(mcp.id, id);
    assert.deepEqual(mcp.argv, canonical);
    assert.deepEqual(mcp.effects, cli.effects);
    assert.deepEqual(mcp.target, cli.target);
    assert.equal(mcp.execution.retry, 'never');
  }
  assert.equal(planFigmaCommand(['create', 'polygon', '--points', '2']).allowed, false);
  assert.equal(planFigmaCommand(['create', 'ellipse', '--radius', '2']).allowed, false);
});

test('Vector and Slice creation own canonical cross-Adapter write Plans', () => {
  const network = { vertices: [], segments: [], regions: [] };
  const cases = [
    [['create', 'vector', 'Path', '--network', JSON.stringify(network)], 'create.vector', ['create', 'vector', 'Path', `--network=${JSON.stringify(network)}`]],
    [['create', 'slice', 'Export', '-w', '320', '-h', '180'], 'create.slice', ['create', 'slice', 'Export', '--width=320', '--height=180']],
  ];
  for (const [argv, id, canonical] of cases) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILE_A' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILE_A' });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(mcp.id, id); assert.deepEqual(mcp.argv, canonical);
    assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  }
  assert.equal(planFigmaCommand(['create', 'vector', '--network', '{}']).allowed, false);
  assert.equal(planFigmaCommand(['create', 'slice', '--network', JSON.stringify(network)]).allowed, false);
});

test('Line creation owns one canonical cross-Adapter write Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const mcp = planFigmaCommand([
    'create', 'line', '--x1', '-4', '--x2', '6', '--color', 'var:color/line',
    '--parent', url,
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'create.line');
  assert.deepEqual(mcp.argv, ['create', 'line', '--x1=-4', '--x2=6', '--color=var:color/line', '--parent', '3:1']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  assert.equal(planFigmaCommand(['create', 'line', '--length', '0']).allowed, false);
  assert.equal(planFigmaCommand(['create', 'line', '--color', 'red']).allowed, false);
});

test('Auto Layout creation owns aliases and one canonical cross-Adapter write Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const mcp = planFigmaCommand([
    'create', 'al', 'Stack', '-d', 'col', '-g', '12', '-p', '20',
    '--fill', 'var:color/surface', '--parent', url,
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'create.autolayout');
  assert.deepEqual(mcp.argv, ['create', 'autolayout', 'Stack', '--direction=col', '--gap=12', '--padding=20', '--fill=var:color/surface', '--parent', '3:1']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  assert.equal(planFigmaCommand(['create', 'autolayout', '--direction', 'grid']).allowed, false);
  assert.equal(planFigmaCommand(['create', 'autolayout', '--fill', 'red']).allowed, false);
});

test('Text creation owns one canonical cross-Adapter write Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const mcp = planFigmaCommand([
    'create', 'text', 'Hello', '-s', '18', '-w', 'BOLD', '--font', 'Roboto',
    '--color', 'var:color/text', '--width', '240', '--parent', url,
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'create.text');
  assert.deepEqual(mcp.argv, ['create', 'text', 'Hello', '--size=18', '--color=var:color/text', '--weight=bold', '--font=Roboto', '--width=240', '--parent', '3:1']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  assert.equal(planFigmaCommand(['create', 'text']).allowed, false);
  assert.equal(planFigmaCommand(['create', 'text', 'Hello', '--weight', 'black']).allowed, false);
});

test('Measurement mutations own action-specific canonical cross-Adapter write Plans', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-2';
  const cases = [
    [['measure', 'add', `${url}:right`, '3-4:left', '--relative', '0.5', '--text', 'Gap'], 'measure.add', ['measure', 'add', '1:2:right', '3:4:left', '--relative=0.5', '--text=Gap']],
    [['measure', 'edit', 'm:1', '--offset', '-8'], 'measure.edit', ['measure', 'edit', 'm:1', '--offset=-8']],
    [['measure', 'delete', 'm:1'], 'measure.delete', ['measure', 'delete', 'm:1']],
  ];
  for (const [argv, id, canonical] of cases) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true); assert.equal(mcp.id, id);
    assert.deepEqual(mcp.argv, canonical); assert.deepEqual(mcp.effects, cli.effects);
    assert.equal(mcp.execution.retry, 'never');
  }
  assert.equal(planFigmaCommand(['measure', 'edit', 'm:1']).allowed, false);
  assert.equal(planFigmaCommand(['measure', 'add', '1:2:right', '3:4:left', '--relative', '2']).allowed, false);
});

test('Measurement list owns one canonical cross-Adapter safe-read Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-2';
  const mcp = planFigmaCommand(['measure', 'list', url], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true);
  assert.equal(mcp.id, 'measure.list');
  assert.deepEqual(mcp.argv, ['measure', 'list', '--', '1:2']);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.deepEqual(mcp.effects, cli.effects);
  assert.equal(mcp.execution.retry, 'safe-read');
  assert.equal(planFigmaCommand(['measure', 'list', '1:2', '3:4']).allowed, false);
});

test('Prototype mutations own canonical cross-Adapter write Plans', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-2';
  const cases = [
    [['prototype', 'add', url, '--trigger', 'hover', '--navigate-to', '3:4'], 'prototype.add'],
    [['prototype', 'set', url, '--json', '[{"trigger":null,"actions":[{"type":"BACK"}]}]'], 'prototype.set'],
    [['prototype', 'clear', url], 'prototype.clear'],
  ];
  for (const [argv, id] of cases) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true); assert.equal(mcp.id, id);
    assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
    assert.equal(mcp.target.fileKey, 'FILEA');
  }
  assert.equal(planFigmaCommand(['prototype', 'add', '1:2']).allowed, false);
  assert.equal(planFigmaCommand(['prototype', 'set', '1:2', '--json', '{}']).allowed, false);
});

test('Library imports own canonical cross-Adapter irreversible write Plans', () => {
  for (const subcommand of [
    'import-variable', 'import-style', 'import-component', 'import-component-set',
  ]) {
    const raw = ['library', subcommand, ' PUBLISHED_KEY '];
    const mcp = planFigmaCommand(raw, { adapter: 'mcp', fileKey: 'FILE_A' });
    const cli = planFigmaCommand(raw, { adapter: 'cli', fileKey: 'FILE_A' });
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.argv, ['library', subcommand, '--', 'PUBLISHED_KEY']);
    assert.deepEqual(mcp.argv, cli.argv);
    assert.deepEqual(mcp.effects, cli.effects);
    assert.equal(mcp.effects.figma, 'write');
    assert.equal(mcp.execution.retry, 'never');
  }
});

test('Shader mutations own canonical cross-Adapter non-retrying write Plans', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-2';
  const cases = [
    [['shader', 'import', ' SH:1 '], ['shader', 'import', '--', 'SH:1'], 'shader.import'],
    [[
      'shader', 'apply', url, 'SH:1', '--field=fill', '--properties', '{"power":2}',
    ], [
      'shader', 'apply', '--field', 'fill', '--properties', '{"power":2}', '--', '1:2', 'SH:1',
    ], 'shader.apply'],
  ];
  for (const [raw, canonical, id] of cases) {
    const mcp = planFigmaCommand(raw, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true); assert.equal(mcp.id, id);
    assert.deepEqual(mcp.argv, canonical); assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(mcp.effects.figma, 'write'); assert.equal(mcp.execution.retry, 'never');
    if (id === 'shader.apply') assert.equal(mcp.target.fileKey, 'FILEA');
  }
  assert.equal(planFigmaCommand(['shader', 'import']).allowed, false);
  assert.equal(planFigmaCommand(['shader', 'apply', '1:2', 'SH:1']).allowed, false);
});

test('Shader list owns one canonical cross-Adapter safe-read Plan', () => {
  const mcp = planFigmaCommand(['shader', 'list'], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true);
  assert.equal(mcp.id, 'shader.list');
  assert.deepEqual(mcp.argv, ['shader', 'list']);
  assert.deepEqual(mcp.effects, cli.effects);
  assert.equal(mcp.execution.retry, 'safe-read');
  assert.equal(planFigmaCommand(['shader', 'list', 'extra']).allowed, false);
});

test('Slot create and edit own canonical cross-Adapter non-retrying write Plans', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  const cases = [
    [[
      'slot', 'create', url, 'Content', '--settings', '{"minChildren":1}',
    ], 'slot.create'],
    [[
      'slot', 'edit', url, 'Content#1:1', '--name', 'Body', '--preferred', '[]',
    ], 'slot.edit'],
  ];
  for (const [raw, id] of cases) {
    const mcp = planFigmaCommand(raw, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true); assert.equal(mcp.id, id);
    assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
    assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  }
  assert.equal(planFigmaCommand(['slot', 'create', '1:1']).allowed, false);
  assert.equal(planFigmaCommand(['slot', 'edit', '1:1', 'Content#1:1']).allowed, false);
});

test('Slot inspect and validate own canonical cross-Adapter safe-read Plans', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  for (const argv of [['slot', 'inspect', url], ['slot', 'validate'], ['slot', 'validate', url]]) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true);
    assert.equal(mcp.id, `slot.${argv[1]}`);
    assert.deepEqual(mcp.effects, cli.effects);
    assert.equal(mcp.execution.retry, 'safe-read');
    assert.equal(mcp.effects.editor, argv[1] === 'validate' ? 'read' : 'none');
  }
  assert.equal(planFigmaCommand(['slot', 'inspect']).allowed, false);
  assert.equal(planFigmaCommand(['slot', 'validate', '1:1', '2:1']).allowed, false);
});

test('Slot reset owns one URL-targeted irreversible non-retrying Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const mcp = planFigmaCommand(['slot', 'reset', url], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'slot.reset'); assert.deepEqual(mcp.argv, ['slot', 'reset', '--', '2:1']);
  assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(planFigmaCommand(['slot', 'reset']).allowed, false);
});

test('Grid Inspect owns one URL-targeted cross-Adapter safe-read Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=2-1';
  const mcp = planFigmaCommand(['layout', 'grid', 'inspect', url], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.inspect');
  assert.deepEqual(mcp.argv, ['layout', 'grid', 'inspect', '--', '2:1']);
  assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.execution.retry, 'safe-read');
  assert.equal(mcp.target.fileKey, 'FILEA'); assert.equal(mcp.effects.figma, 'read');
  assert.equal(planFigmaCommand(['layout', 'grid', 'inspect']).allowed, false);
  assert.equal(planFigmaCommand(['layout', 'grid', 'inspect', '2:1', '3:1']).allowed, false);
});

test('Grid Auto Flow owns one URL-targeted rollback-capable non-retrying Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=2-1';
  const mcp = planFigmaCommand([
    'layout', 'grid', 'auto-flow', url,
    '--positioning=row_auto_flow', '--auto-tracks', 'rows',
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.auto-flow');
  assert.deepEqual(mcp.argv, [
    'layout', 'grid', 'auto-flow', '--auto-tracks', 'rows',
    '--positioning', 'row_auto_flow', '--', '2:1',
  ]);
  assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(planFigmaCommand(['layout', 'grid', 'auto-flow', '2:1']).allowed, false);
});

test('Grid Set owns one URL-targeted journaled non-retrying Plan', () => {
  const url = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=2-1';
  const mcp = planFigmaCommand([
    'layout', 'grid', 'set', '--row-gap=12', url, '--rows', '2',
    '--row-sizes', '[{"type":"fixed","value":40},{"type":"hug"}]',
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.set');
  assert.deepEqual(mcp.argv, [
    'layout', 'grid', 'set', '--rows', '2', '--row-gap', '12',
    '--row-sizes', '[{"type":"FIXED","value":40},{"type":"HUG"}]', '--', '2:1',
  ]);
  assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(planFigmaCommand(['layout', 'grid', 'set', '2:1']).allowed, false);
});

test('Grid Place owns one dual-URL rollback-capable non-retrying Plan', () => {
  const grid = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=2-1';
  const child = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=3-1';
  const mcp = planFigmaCommand([
    'layout', 'grid', 'place', child, '--column=2', grid, '--row', '1',
    '--row-span', '2', '--horizontal-align', 'center',
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.place');
  assert.deepEqual(mcp.argv, [
    'layout', 'grid', 'place', '--row', '1', '--column', '2', '--row-span', '2',
    '--horizontal-align', 'center', '--', '3:1', '2:1',
  ]);
  assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(planFigmaCommand([
    'layout', 'grid', 'place', '2:1', '3:1', '--row', '0',
  ]).allowed, false);
});

test('Grid Track Reorder owns one URL-targeted irreversible non-retrying Plan per axis', () => {
  const url = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=2-1';
  for (const action of ['reorder-rows', 'reorder-columns']) {
    const mcp = planFigmaCommand([
      'layout', 'grid', action, '--to=3', url, '--from', '0,2',
    ], { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(mcp.id, `layout.grid.${action}`);
    assert.deepEqual(mcp.argv, [
      'layout', 'grid', action, '--from', '0,2', '--to', '3', '--', '2:1',
    ]);
    assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
    assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  }
  assert.equal(planFigmaCommand([
    'layout', 'grid', 'reorder-rows', '2:1', '--from', '0',
  ]).allowed, false);
});

test('Font Axis Metadata owns URL-targeted cross-Adapter read and write Plans', () => {
  const url = 'https://www.figma.com/design/FILEA/FILE_NAME?node-id=2-1';
  const cases = [
    [['font', 'axes', url], 'font.axes', 'safe-read', 'read'],
    [['font', 'remember-axes', url, 'wght=357', '--start', '1', '--end', '4'], 'font.remember-axes', 'never', 'write'],
    [['font', 'forget-axes', '--start=1', url, '--end=4'], 'font.forget-axes', 'never', 'write'],
  ];
  for (const [argv, id, retry, figma] of cases) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true); assert.equal(mcp.id, id);
    assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.execution.retry, retry);
    assert.equal(mcp.effects.figma, figma); assert.equal(mcp.target.fileKey, 'FILEA');
  }
  assert.equal(planFigmaCommand(['font', 'axes']).allowed, false);
  assert.equal(planFigmaCommand(['font', 'remember-axes', '2:1', 'wght=nope']).allowed, false);
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

test('History Save owns one canonical cross-Adapter non-retrying write Plan', () => {
  const variants = [
    ['history', 'save', 'Release 1', '--description', 'Ready'],
    ['history', 'save', '--description=Ready', '--', 'Release 1'],
  ];
  for (const argv of variants) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILE_A' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILE_A' });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(mcp.id, 'history.save');
    assert.deepEqual(mcp.argv, [
      'history', 'save', '--description', 'Ready', '--', 'Release 1',
    ]);
    assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.effects.figma, 'write');
    assert.equal(mcp.effects.shared, 'none'); assert.equal(mcp.execution.retry, 'never');
  }
  assert.equal(planFigmaCommand(['history', 'save']).allowed, false);
  assert.equal(planFigmaCommand(['history', 'save', 'A', 'B']).allowed, false);
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
      figma: 'read', editor: 'none', workspace: 'write', network: 'none', shared: 'none',
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
    effects: { figma: 'write', editor: 'none', workspace: 'read', network: 'none', shared: 'none' },
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
