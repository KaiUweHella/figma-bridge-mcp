import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseActions, parseReactions, parseTrigger, prototypeAddCode, prototypeClearCode,
  prototypeInspectCode, prototypeSetCode,
} from '../src/lib/prototype-management.js';

const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture() {
  const node = { id: '1:2', name: 'Button', type: 'FRAME', reactions: [], async setReactionsAsync(value) { this.reactions = value; } };
  return { node, figma: { getNodeByIdAsync: async (id) => id === node.id ? node : null } };
}

test('prototype parsers preserve full reaction/action JSON and normalize convenient triggers', () => {
  assert.deepEqual(parseTrigger('click'), { type: 'ON_CLICK' });
  assert.deepEqual(parseTrigger('after:1.5'), { type: 'AFTER_TIMEOUT', timeout: 1.5 });
  assert.equal(parseActions('[{"type":"SET_VARIABLE","variableId":"V:1"}]')[0].type, 'SET_VARIABLE');
  assert.equal(parseReactions('[{"trigger":null,"actions":[]}]').length, 1);
  assert.throws(() => parseActions('{}'), /array/);
});

test('prototype commands read, append, replace, and clear through setReactionsAsync', async () => {
  const { node, figma } = fixture();
  await execute(prototypeAddCode({ nodeId: node.id, trigger: 'click', navigateTo: '3:4' }), figma);
  assert.equal(node.reactions[0].actions[0].destinationId, '3:4');
  assert.equal((await execute(prototypeInspectCode({ nodeId: node.id }), figma)).reactions.length, 1);
  await execute(prototypeSetCode({ nodeId: node.id, reactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'BACK' }] }] }), figma);
  assert.equal(node.reactions[0].actions[0].type, 'BACK');
  assert.equal((await execute(prototypeClearCode({ nodeId: node.id }), figma)).removed, 1);
});
