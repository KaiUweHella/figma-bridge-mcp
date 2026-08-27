import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  parseComponentSetReferenceRequest,
  componentSetReferenceArgvFromRequest,
} from '../src/application/component-set-reference-request.js';
import {
  parseSlidesReferenceRequest,
  slidesReferenceArgvFromRequest,
} from '../src/application/slides-reference-request.js';
import {
  parseUnionReference,
  unionReferenceArgvValue,
} from '../src/application/union-reference.js';

const NODE_URL = 'https://www.figma.com/design/ARGUMENTPLACEHOLDERKEY/FILE_NAME?node-id=12-34';

test('Union Reference keeps bare and URL-shaped payloads in the compatibility query', () => {
  for (const value of ['12:34', 'Button', NODE_URL, 'node-shaped authored name']) {
    const reference = parseUnionReference(value);
    assert.equal(reference.kind, 'query');
    assert.equal(reference.value, value);
    assert.equal(reference.fileKey, null);
    assert.equal(Object.isFrozen(reference), true);
  }
});

test('Union Reference projects target identity only from an explicit node variant', () => {
  const node = parseUnionReference(`node:${NODE_URL}`);
  assert.deepEqual({ kind: node.kind, value: node.value, fileKey: node.fileKey }, {
    kind: 'node', value: '12:34', fileKey: 'ARGUMENTPLACEHOLDERKEY',
  });
  assert.equal(unionReferenceArgvValue(node), 'node:12:34');
  assert.equal(parseUnionReference(`name:${NODE_URL}`).fileKey, null);
  assert.equal(parseUnionReference(`label:${NODE_URL}`).fileKey, null);
  assert.throws(
    () => parseUnionReference('label:Bridge', { allowedKinds: ['node', 'name', 'query'] }),
    /kind-label/,
  );
});

test('Slides reference requests canonicalize every reference action without touching labels', () => {
  const inspect = parseSlidesReferenceRequest(['slides', 'inspect', `node:${NODE_URL}`]);
  assert.deepEqual(slidesReferenceArgvFromRequest(inspect), ['slides', 'inspect', 'node:12:34']);

  const duplicate = parseSlidesReferenceRequest([
    'slides', 'duplicate', `label:${NODE_URL}`, '--row', '1', '--label', 'Copy',
  ]);
  assert.equal(duplicate.reference.kind, 'label');
  assert.equal(duplicate.reference.fileKey, null);
  assert.deepEqual(slidesReferenceArgvFromRequest(duplicate), [
    'slides', 'duplicate', `label:${NODE_URL}`, '--row', '1', '--label', 'Copy',
  ]);
  assert.throws(() => parseSlidesReferenceRequest(['slides', 'move', 'one', '0']), /missing/);
});

test('Component Set reference request closes options and canonicalizes its target', () => {
  const request = parseComponentSetReferenceRequest([
    'component', 'add-variant', `node:${NODE_URL}`, 'State=Hover', '--json', '--from', 'State=Default',
  ]);
  assert.equal(request.reference.fileKey, 'ARGUMENTPLACEHOLDERKEY');
  assert.deepEqual(componentSetReferenceArgvFromRequest(request), [
    'component', 'add-variant', 'node:12:34', 'State=Hover', '--from=State=Default', '--json',
  ]);
  assert.throws(
    () => parseComponentSetReferenceRequest(['component', 'add-variant', 'label:Button', 'State=Hover']),
    /kind-label/,
  );
});

test('Slides and Component Set plans derive targets only from typed node references', () => {
  for (const argv of [
    ['slides', 'inspect', `node:${NODE_URL}`],
    ['component', 'add-variant', `node:${NODE_URL}`, 'State=Hover'],
  ]) {
    const plan = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(plan.allowed, true, argv.join(' '));
    assert.equal(plan.target.fileKey, 'ARGUMENTPLACEHOLDERKEY', argv.join(' '));
    assert.equal(plan.target.source, 'figma-url', argv.join(' '));
  }

  for (const argv of [
    ['slides', 'inspect', `label:${NODE_URL}`],
    ['slides', 'inspect', NODE_URL],
    ['component', 'add-variant', `name:${NODE_URL}`, 'State=Hover'],
    ['component', 'add-variant', NODE_URL, 'State=Hover'],
  ]) {
    const plan = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(plan.allowed, true, argv.join(' '));
    assert.equal(plan.target.fileKey, null, argv.join(' '));
    assert.equal(plan.target.source, 'implicit-single-window', argv.join(' '));
  }
});

test('Union-reference Commands produce policy-identical CLI and MCP plans', () => {
  for (const argv of [
    ['canvas', 'page', `node:${NODE_URL}`],
    ['slides', 'inspect', `label:${NODE_URL}`],
    ['slides', 'move', 'query:Agenda', '0', '1'],
    ['component', 'add-variant', 'name:Button', 'State=Hover', '--json'],
  ]) {
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
    const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
    assert.equal(mcp.allowed, true, argv.join(' '));
    assert.equal(cli.allowed, argv[0] === 'canvas', argv.join(' '));
    assert.deepEqual(cliPolicy, mcpPolicy, argv.join(' '));
    assert.deepEqual(cli.audit, mcp.audit, argv.join(' '));
  }
});
