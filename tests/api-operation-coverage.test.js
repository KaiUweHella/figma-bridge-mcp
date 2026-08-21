import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

import { listFigmaCapabilities, planFigmaCommand } from '../src/capability-catalog.js';
import {
  FIGMA_TYPINGS_AUDITED_VERSION,
  PLUGIN_API_CREATION_OPERATIONS,
  PLUGIN_API_STRUCTURAL_OPERATIONS,
} from '../engine/src/lib/api-operation-coverage.js';
import {
  EASING_TYPES, VARIABLE_TYPES, parseVariableLiteral, parseVariableType,
} from '../engine/src/lib/variable-management.js';
import { parseSetRequest, setCode } from '../engine/src/commands/node-ops.js';

const typingsPath = new URL('../node_modules/@figma/plugin-typings/plugin-api.d.ts', import.meta.url);
const packagePath = new URL('../node_modules/@figma/plugin-typings/package.json', import.meta.url);
const sourceText = readFileSync(typingsPath, 'utf8');
const sourceFile = ts.createSourceFile('plugin-api.d.ts', sourceText, ts.ScriptTarget.Latest, true);
const pluginApi = sourceFile.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'PluginAPI');
const engineEntry = new URL('../engine/src/index.js', import.meta.url);

function methodNames(predicate) {
  return pluginApi.members
    .filter(ts.isMethodSignature)
    .map((member) => member.name.getText(sourceFile))
    .filter(predicate)
    .sort();
}

test('the operation audit is pinned to the installed official Figma typings release', () => {
  const installed = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  assert.equal(installed, FIGMA_TYPINGS_AUDITED_VERSION, 'Review new Figma operations before updating the audited version');
});

test('every official PluginAPI creation operation is explicitly classified', () => {
  assert.deepEqual(
    Object.keys(PLUGIN_API_CREATION_OPERATIONS).sort(),
    methodNames((name) => name.startsWith('create')),
  );
});

test('every official PluginAPI structural operation is explicitly classified', () => {
  const structural = new Set(['combineAsVariants', 'group', 'transformGroup', 'flatten', 'union', 'subtract', 'intersect', 'exclude', 'ungroup']);
  assert.deepEqual(
    Object.keys(PLUGIN_API_STRUCTURAL_OPERATIONS).sort(),
    methodNames((name) => structural.has(name)),
  );
});

test('supported and alternative operations are reachable through the Safe Mode capability plan', () => {
  const entries = [...Object.entries(PLUGIN_API_CREATION_OPERATIONS), ...Object.entries(PLUGIN_API_STRUCTURAL_OPERATIONS)];
  for (const [operation, entry] of entries) {
    assert.ok(['supported', 'alternative', 'boundary'].includes(entry.status), operation);
    if (entry.status === 'boundary') {
      assert.equal(entry.command, null, operation);
      assert.ok(entry.note, `${operation} boundary needs a reason`);
    } else {
      assert.equal(planFigmaCommand([...entry.command]).allowed, true, `${operation}: ${entry.command.join(' ')}`);
    }
  }
});

function commandRows(...args) {
  const output = execFileSync(process.execPath, [engineEntry.pathname, ...args, '--help'], { encoding: 'utf8' });
  return [...output.matchAll(/^  ([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)?)(?:\s|$)/gm)]
    .map((match) => match[1].split('|'))
    .filter((names) => names[0] !== 'help');
}

test('every real engine command is either Safe-Mode reachable or explicitly engine-only', () => {
  const catalog = new Set(listFigmaCapabilities().map(({ name }) => name));
  const engineOnly = new Set(['status', 'connect', 'daemon', 'config', 'eval', 'run']);
  const rows = commandRows();
  for (const aliases of rows) {
    assert.ok(aliases.some((name) => catalog.has(name)) || engineOnly.has(aliases[0]), `Unclassified engine command: ${aliases.join('|')}`);
  }
  for (const name of catalog) {
    assert.ok(rows.some((aliases) => aliases.includes(name)), `Capability Catalog command is missing from the engine: ${name}`);
  }
});

test('every create subcommand is Safe-Mode reachable or an explicit legacy boundary', () => {
  const legacyBoundaries = new Set(['image', 'component', 'group']);
  for (const aliases of commandRows('create')) {
    const allowed = aliases.some((name) => planFigmaCommand(['create', name]).allowed);
    assert.ok(allowed || aliases.some((name) => legacyBoundaries.has(name)), `Unclassified create subcommand: ${aliases.join('|')}`);
  }
});

test('Figma 1.133 variable literals validate EASING and TIMING without executable input', () => {
  assert.equal(parseVariableType('timing'), 'TIMING');
  assert.equal(parseVariableLiteral('0.24', 'TIMING'), 0.24);
  assert.deepEqual(parseVariableLiteral('ease-in-and-out', 'EASING'), { type: 'EASE_IN_AND_OUT' });
  assert.deepEqual(
    parseVariableLiteral('{"type":"CUSTOM_CUBIC_BEZIER","easingFunctionCubicBezier":{"x1":0.2,"y1":0,"x2":0,"y2":1}}', 'EASING'),
    { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } },
  );
  assert.throws(() => parseVariableLiteral('-1', 'TIMING'), /zero or greater/);
  assert.throws(() => parseVariableLiteral('alert(1)', 'EASING'), /Unknown EASING type/);
});

test('all official variable and easing value types are exhaustively recognized', () => {
  const variableType = sourceFile.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'VariableResolvedDataType');
  const officialVariableTypes = variableType.type.types.map((type) => type.literal.text).sort();
  assert.deepEqual([...VARIABLE_TYPES].sort(), officialVariableTypes);

  const motionEasing = sourceFile.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'MotionEasing');
  const typeProperty = motionEasing.members.find((member) => ts.isPropertySignature(member) && member.name.getText(sourceFile) === 'type');
  const officialEasingTypes = typeProperty.type.types.map((type) => type.literal.text).sort();
  assert.deepEqual([...EASING_TYPES].sort(), officialEasingTypes);
});

test('variable collections have a scoped deletion command instead of requiring delete-all', () => {
  const output = execFileSync(process.execPath, [engineEntry.pathname, 'col', '--help'], { encoding: 'utf8' });
  assert.match(output, /\bdelete\b/);
  assert.equal(planFigmaCommand(['col', 'delete', 'Audit']).effects.figma, 'write');
});

test('extended node edits are typed before they become plugin code', () => {
  const request = parseSetRequest({
    node: '1:2', locked: 'true', rotation: '12.5', blendMode: 'soft-light',
    clip: false, strokeAlign: 'inside', strokeJoin: 'round', dashPattern: '4,2',
    radii: '4,8,12,16', cornerSmoothing: '0.5', layoutMode: 'column',
    itemSpacing: '12', padding: '8', constraintsHorizontal: 'stretch',
    effects: '[{"type":"LAYER_BLUR","radius":4,"visible":true}]',
  });
  assert.deepEqual(request.props.radii, [4, 8, 12, 16]);
  assert.deepEqual(request.props.dashPattern, [4, 2]);
  assert.equal(request.props.layoutMode, 'VERTICAL');
  assert.equal(request.props.blendMode, 'SOFT_LIGHT');
  assert.equal(request.props.locked, true);
  const code = setCode([request]);
  assert.match(code, /node\.effects = p\.effects/);
  assert.match(code, /node\.constraints =/);
  assert.throws(() => parseSetRequest({ node: '1:2', locked: 'yes' }), /true or false/);
  assert.throws(() => parseSetRequest({ node: '1:2', radii: '1,2' }), /four values/);
  assert.throws(() => parseSetRequest({ node: '1:2', blendMode: 'javascript' }), /must be one of/);
});
