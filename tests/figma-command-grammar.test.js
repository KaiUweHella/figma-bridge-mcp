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
