import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeShaderRead,
  executeShaderReadPlan,
  MAX_SHADER_READ_ITEMS,
  shaderReadCode,
  shaderReadPlanRoute,
} from '../src/application/shader-read-command.js';
import { acceptsShaderReadArgv, parseShaderReadRequest } from '../src/application/shader-read-request.js';

const FACTS = [
  {
    id: 'shader-fill', name: 'Soft Fill', type: 'fill', imported: false,
    propertyDefinitions: null,
  },
  {
    id: 'shader-effect', name: 'Glass', type: 'effect', imported: true,
    propertyDefinitions: {
      strength: { name: 'Strength', type: 'NUMBER', defaultValue: 0.5 },
      tint: { name: 'Tint', type: 'COLOR', description: 'Overlay tint' },
    },
  },
];

test('Shader Read closes its argument-free request', () => {
  assert.deepEqual(parseShaderReadRequest(['shader', 'list']), { action: 'list' });
  assert.deepEqual(parseShaderReadRequest(['shader', 'list', '--']), { action: 'list' });
  assert.equal(acceptsShaderReadArgv(['shader', 'list']), true);
  for (const argv of [
    ['shader', 'list', 'extra'],
    ['shader', 'list', '--future'],
    ['shader', 'list', '--', 'private-value'],
  ]) assert.equal(acceptsShaderReadArgv(argv), false, argv.join(' '));
});

test('Shader Read preserves order and optional property-definition fields', async () => {
  const figma = {
    listAvailableShaders: async () => [
      { id: 'shader-fill', name: 'Soft Fill', type: 'fill', imported: false },
      {
        id: 'shader-effect', name: 'Glass', type: 'effect', imported: true,
        propertyDefinitions: {
          strength: { name: 'Strength', type: 'NUMBER', defaultValue: 0.5 },
          tint: { name: 'Tint', type: 'COLOR', description: 'Overlay tint' },
        },
      },
    ],
  };
  const result = await executeShaderRead({}, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(figma),
  });
  assert.deepEqual(result.result, FACTS);
  assert.deepEqual(JSON.parse(result.stdout), FACTS);
  assert.equal(Object.hasOwn(result.result[1].propertyDefinitions.strength, 'description'), false);
  assert.equal(Object.hasOwn(result.result[1].propertyDefinitions.tint, 'defaultValue'), false);
});

test('Shader Read rejects malformed, duplicate, and oversized Plugin facts', async () => {
  for (const value of [
    'not-json',
    JSON.stringify([{ ...FACTS[0], privateField: 'x' }]),
    JSON.stringify([{ ...FACTS[0], type: 'paint' }]),
    JSON.stringify([FACTS[0], FACTS[0]]),
    JSON.stringify(Array(MAX_SHADER_READ_ITEMS + 1).fill(FACTS[0])),
    JSON.stringify([{ ...FACTS[1], propertyDefinitions: {
      invalid: { name: 'Invalid', type: 'FUTURE' },
    } }]),
  ]) {
    await assert.rejects(
      () => executeShaderRead({}, { evaluate: async () => value }),
      /invalid (?:JSON|bounded result)/,
    );
  }
});

test('Shader Read uses one safe-read Application in CLI and MCP Plans', async () => {
  const mcp = planFigmaCommand(['shader', 'list'], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true);
  assert.equal(mcp.id, 'shader.list');
  assert.equal(mcp.execution.retry, 'safe-read');
  assert.deepEqual(mcp.effects, cli.effects);
  assert.equal(shaderReadPlanRoute(mcp), 'command-application');
  const result = await executeShaderReadPlan(mcp, {
    evaluate: async () => JSON.stringify(FACTS),
  });
  assert.deepEqual(result.result, FACTS);
  assert.throws(
    () => executeShaderReadPlan({ ...mcp }, { evaluate: async () => '[]' }),
    /requires a Command Plan/,
  );
});

test('Shader Read owns the Plan deadline instead of embedding a private timer', () => {
  const source = shaderReadCode({});
  assert.doesNotMatch(source, /setTimeout|18s/);
  assert.match(source, /await figma\.listAvailableShaders\(\)/);
});
