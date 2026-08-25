import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listFigmaCommandGrammar,
  resolveFigmaCommandAction,
} from '../src/figma-command-grammar.js';
import { planFigmaCommand } from '../src/capability-catalog.js';

test('unknown nested commands fail closed even when followed by help', () => {
  for (const args of [
    ['node', 'future-action'],
    ['node', 'future-action', '--help'],
    ['layout', 'future-group'],
    ['layout', 'grid', 'future-action'],
    ['component', 'prop', 'future-action'],
    ['export', 'future-action'],
  ]) {
    const resolved = resolveFigmaCommandAction(args);
    const plan = planFigmaCommand(args);
    assert.equal(resolved.accepted, false, args.join(' '));
    assert.equal(plan.allowed, false, args.join(' '));
    assert.equal(plan.effects.figma, 'write', args.join(' '));
    assert.equal(plan.execution.retry, 'never', args.join(' '));
    assert.equal(plan.audit.capability, 'unknown', args.join(' '));
  }
});

test('nested actions and documented aliases resolve to canonical safe action ids', () => {
  const examples = [
    [['node', 'set', '1:2', '--name', 'Secret layer'], 'node.set'],
    [['component', 'prop', 'set', '1:2', 'Label', 'Private value'], 'component.prop.set'],
    [['layout', 'grid', 'inspect', '1:2'], 'layout.grid.inspect'],
    [['create', 'rectangle', 'Private name'], 'create.rect'],
    [['create', 'circle', 'Private name'], 'create.ellipse'],
    [['create', 'al', 'Private name'], 'create.autolayout'],
    [['analyze', 'type'], 'analyze.typography'],
    [['api', 'SceneNode'], 'api.lookup'],
    [['api', '--full'], 'api.lookup'],
  ];
  for (const [args, actionId] of examples) {
    const plan = planFigmaCommand(args);
    assert.equal(plan.allowed, true, args.join(' '));
    assert.equal(plan.id, actionId, args.join(' '));
    assert.equal(plan.audit.capability, actionId, args.join(' '));
    assert.match(actionId, /^[a-z0-9][a-z0-9.-]*$/);
    assert.doesNotMatch(actionId, /Secret|Private|1:2/);
  }
});

test('inherited create escape hatches stay explicit and unavailable', () => {
  const create = listFigmaCommandGrammar().find((node) => node.name === 'create');
  for (const name of ['image', 'component', 'group']) {
    const blocked = create.children.find((node) => node.name === name);
    assert.equal(blocked.exposed, false, name);
    assert.equal(resolveFigmaCommandAction(['create', name]).accepted, false, name);
    assert.equal(planFigmaCommand(['create', name]).allowed, false, name);
  }
});

test('unsafe legacy variable bulk deletion stays explicit and unavailable', () => {
  const variable = listFigmaCommandGrammar().find((node) => node.name === 'var');
  const blocked = variable.children.find((node) => node.name === 'delete-all');
  assert.equal(blocked.exposed, false);
  assert.equal(resolveFigmaCommandAction(['var', 'delete-all']).accepted, false);
  assert.equal(resolveFigmaCommandAction(['var', 'delete', 'space/md']).accepted, true);
});

test('invalid group options are denied without pretending they might write', () => {
  for (const args of [['node', '--future-option'], ['api', '--future-option']]) {
    const plan = planFigmaCommand(args);
    assert.equal(plan.allowed, false, args.join(' '));
    assert.equal(plan.effects.figma, 'none', args.join(' '));
    assert.equal(plan.target.kind, 'none', args.join(' '));
    assert.equal(plan.audit.capability, 'unknown', args.join(' '));
  }
});

test('bare groups and help forms stay discoverable without becoming writes', () => {
  for (const args of [
    ['node'], ['node', '--help'], ['node', 'set', '--help'],
    ['layout', 'grid', '--help'], ['render', '--help'], ['--help'],
  ]) {
    const plan = planFigmaCommand(args);
    assert.equal(plan.allowed, true, args.join(' '));
    assert.notEqual(plan.effects.figma, 'write', args.join(' '));
    assert.equal(plan.target.kind, 'none', args.join(' '));
    assert.match(plan.audit.capability, /(?:^help$|\.help$)/, args.join(' '));
  }
});

test('the option terminator keeps later help tokens in the command payload', () => {
  for (const [args, actionId] of [
    [['node', 'set-text', '1:2', '--', '--help'], 'node.set-text'],
    [['render', '--', '-h'], 'render'],
    [['api', 'SceneNode', '--', '--help'], 'api.lookup'],
    [['api', '--full', '--', '-h'], 'api.lookup'],
  ]) {
    const resolved = resolveFigmaCommandAction(args);
    assert.equal(resolved.accepted, true, args.join(' '));
    assert.equal(resolved.help, false, args.join(' '));
    assert.equal(resolved.actionId, actionId, args.join(' '));
  }

  for (const args of [
    ['node', 'set-text', '1:2', '--help', '--', 'literal'],
    ['render', '-h', '--', 'literal'],
  ]) {
    const resolved = resolveFigmaCommandAction(args);
    assert.equal(resolved.help, true, args.join(' '));
    assert.match(resolved.actionId, /\.help$/, args.join(' '));
  }
});

test('the grammar resolves policy option facts only before the first terminator', () => {
  const resolved = resolveFigmaCommandAction([
    'tokens', 'sync', '--collection=Theme', 'tokens.json', '--apply', '--',
    '--apply', '--lockfile', 'literal.json',
  ]);
  assert.equal(resolved.accepted, true);
  assert.equal(resolved.options.terminatorIndex, 5);
  assert.deepEqual(resolved.options.entries, [
    { name: '--collection', index: 2, inline: true },
    { name: '--apply', index: 4, inline: false },
  ]);
});

test('legacy policy option schemas reject unknown, duplicate, malformed, and conflicting options', () => {
  const rejected = [
    ['tokens', 'sync', 'tokens.json', '--future'],
    ['tokens', 'sync', 'tokens.json', '-c', 'One', '--collection', 'Two'],
    ['tokens', 'sync', 'tokens.json', '--lockfile'],
    ['tokens', 'sync', 'tokens.json', '--ours', '--theirs'],
    ['tokens', 'rebind', 'Theme', '--node', '1:2', '--page'],
    ['gradient', 'extract', 'hero.png', '--apply-to'],
    ['gradient', 'extract', 'hero.png', '--json=true'],
    ['export', 'node', '1:2', '-o', 'one.png', '--output', 'two.png'],
    ['extract', '--split', '--no-split'],
    ['spec', 'Button', '--file='],
    ['map', 'storybook', 'storybook', '--output'],
    ['verify-build', '.', '--node', '--json'],
    ['import', 'tokens.json', '--save'],
    ['motion', 'apply', 'motion.json', '--future'],
    ['kit', 'init', '.', '--storybook='],
  ];
  for (const args of rejected) {
    const result = resolveFigmaCommandAction(args);
    assert.equal(result.accepted, false, args.join(' '));
    assert.equal(result.reason, 'unknown-option', args.join(' '));
  }
});

test('legacy policy option schemas preserve valid aliases, inline values, globals, and literal payload', () => {
  const accepted = [
    ['tokens', 'sync', 'tokens.json', '-c', 'Theme', '--apply', '--lockfile=state.json'],
    ['tokens', 'rebind', 'Theme', '--node=1:2', '--apply'],
    ['gradient', 'extract', 'hero.png', '--mode', 'mesh', '--json'],
    ['export', 'node', '1:2', '-o', 'node.png', '--format=png'],
    ['extract', 'DESIGN.md', '--pages', 'Main', '--selection'],
    ['spec', 'Button', '-f', 'DESIGN.md', '--tolerance=2'],
    ['map', 'storybook', 'storybook', '--current-page', '-omap.json'],
    ['verify-build', '.', '--assets=assets.json', '--json'],
    ['import', 'tokens.json', '--type=tokens', '--figma-file', 'FILEKEY'],
    ['motion', 'apply', '--', '--future'],
    ['kit', 'init', '.', '--out', 'design', '--', '--storybook=literal'],
    ['tokens', 'sync', '--', '--apply', '--future'],
  ];
  for (const args of accepted) {
    assert.equal(resolveFigmaCommandAction(args).accepted, true, args.join(' '));
  }
});

test('legacy policy facts preserve Commander short-attached value semantics', () => {
  const resolved = resolveFigmaCommandAction([
    'export', 'node', '1:2', '-onode.png', '-fpng', '-s2',
  ]);
  assert.equal(resolved.accepted, true);
  assert.deepEqual(resolved.options.entries, [
    { name: '-o', index: 3, inline: true },
    { name: '-f', index: 4, inline: true },
    { name: '-s', index: 5, inline: true },
  ]);
});

test('the global Figma target option fails closed for every Legacy action', () => {
  for (const args of [
    ['create', 'frame', 'Card', '--figma-file'],
    ['node', 'rename', '1:2', 'Card', '--figma-file='],
    ['component', 'instantiate', 'Button', '--figma-file', 'ONE', '--figma-file', 'TWO'],
  ]) {
    const resolved = resolveFigmaCommandAction(args);
    assert.equal(resolved.accepted, false, args.join(' '));
    assert.equal(resolved.reason, 'unknown-option', args.join(' '));
  }

  assert.equal(resolveFigmaCommandAction([
    'create', 'frame', 'Card', '--figma-file=FILEKEY',
  ]).accepted, true);
  assert.equal(resolveFigmaCommandAction([
    'create', 'frame', '--', '--figma-file', 'literal',
  ]).accepted, true);
});

test('every policy-schema Legacy action rejects unknown and duplicate options', () => {
  const cases = [
    [['export', 'screenshot'], ['-o', 'shot.png']],
    [['export', 'node', '1:2'], ['--output', 'node.png']],
    [['export', 'video', '1:2'], ['--fps', '30']],
    [['export', 'node-json', '1:2'], ['-o', 'node.json']],
    [['export', 'dtcg'], ['--dialect', 'legacy']],
    [['gradient', 'extract', 'hero.png'], ['--mode', 'linear']],
    [['tokens', 'import', 'tokens.json'], ['-c', 'Theme']],
    [['tokens', 'sync', 'tokens.json'], ['--lockfile', 'state.json']],
    [['tokens', 'import-design-md', 'DESIGN.md'], ['--collection', 'Theme']],
    [['tokens', 'rebind', 'Theme'], ['--node', '1:2']],
    [['extract'], ['--sections', 'tokens']],
    [['spec', 'Button'], ['-f', 'DESIGN.md']],
    [['map', 'storybook', 'storybook'], ['-o', 'map.json']],
    [['verify-build', '.'], ['--assets', 'assets.json']],
    [['import', 'tokens.json'], ['--save', 'DESIGN.md']],
    [['motion', 'apply', 'motion.json'], ['--figma-file', 'FILEKEY']],
    [['kit', 'init', '.'], ['--out', 'design']],
  ];

  for (const [base, option] of cases) {
    assert.equal(resolveFigmaCommandAction([...base, '--future']).accepted, false,
      `${base.join(' ')} unknown`);
    assert.equal(resolveFigmaCommandAction([...base, ...option, ...option]).accepted, false,
      `${base.join(' ')} duplicate`);
    assert.equal(resolveFigmaCommandAction([...base, option[0]]).accepted, false,
      `${base.join(' ')} malformed`);
  }
});

test('every exposed grammar node has a stable closed projection', () => {
  const roots = listFigmaCommandGrammar();
  assert.ok(roots.length > 40);
  const visit = (node, parents = []) => {
    const path = [...parents, node.name];
    assert.match(path.join('.'), /^[a-z0-9][a-z0-9.-]*$/);
    assert.equal(Object.isFrozen(node), true);
    assert.equal(Object.isFrozen(node.aliases), true);
    assert.equal(Object.isFrozen(node.children), true);
    if (node.positionalOptions) assert.equal(Object.isFrozen(node.positionalOptions), true);
    assert.equal(typeof node.exposed, 'boolean');
    for (const child of node.children) visit(child, path);
  };
  for (const root of roots) visit(root);
});
