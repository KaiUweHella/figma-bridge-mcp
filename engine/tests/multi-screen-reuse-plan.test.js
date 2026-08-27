import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient } from '../src/lib/jsx-render.js';
import {
  assertMultiScreenReuseAcceptance,
  buildMultiScreenReusePlan,
  completeMultiScreenReuseReport,
} from '../src/lib/multi-screen-reuse-plan.js';

const card = (label) => `<Frame name="Card ${label}" flex="col" gap={8} p={16} bg="#ffffff" rounded={12} w={200}>`
  + `<Text size={16} weight="bold">${label}</Text><Text size={12}>Supporting copy</Text></Frame>`;
const screen = (name, content) => `<Frame name="${name}" flex="col" gap={24}>${content}</Frame>`;

describe('multi-screen reuse plan', () => {
  test('records repeated raw structures before write and gives one exact approval recipe', () => {
    const client = new FigmaClient();
    const roots = [screen('First', card('One')), screen('Second', card('Two'))];
    const plan = buildMultiScreenReusePlan(client, roots, {
      direction: 'row', placement: { smart: true, x: null, y: null },
    });

    assert.equal(plan.version, 1);
    assert.equal(plan.rootCount, 2);
    assert.deepEqual(plan.placement, {
      direction: 'row', startsRightOfOccupiedCanvas: true, explicitVertical: false,
    });
    assert.equal(plan.flatRepetitions.length, 1);
    assert.match(plan.flatRepetitions[0].id, /^flat-[0-9a-f]{12}$/);
    assert.equal(plan.flatRepetitions[0].count, 2);
    assert.deepEqual(plan.flatRepetitions[0].rootIndexes, [0, 1]);
    assert.equal(plan.flatRepetitions[0].approved, false);
    assert.throws(
      () => assertMultiScreenReuseAcceptance(plan),
      new RegExp(`${plan.flatRepetitions[0].id}.*<Instance entity=.*--approve-flat-repetition=${plan.flatRepetitions[0].id}`, 's'),
    );
  });

  test('an exact flat approval accepts only the addressed finding', () => {
    const client = new FigmaClient();
    const roots = [screen('First', card('One')), screen('Second', card('Two'))];
    const initial = buildMultiScreenReusePlan(client, roots);
    const approved = buildMultiScreenReusePlan(client, roots, {
      approvedFlatRepetitions: [initial.flatRepetitions[0].id],
    });

    assert.doesNotThrow(() => assertMultiScreenReuseAcceptance(approved));
    assert.equal(approved.flatRepetitions[0].approved, true);
    assert.equal(approved.summary.approvedFlatRepetitions, 1);
    assert.throws(
      () => buildMultiScreenReusePlan(client, roots, {
        approvedFlatRepetitions: ['flat-000000000000'],
      }),
      /does not match a current flat repetition/,
    );
  });

  test('records Design Entity instances across all screens without a flat finding', () => {
    const client = new FigmaClient();
    const instance = (label) => `<Instance entity="ui.card" text:Label="${label}" />`;
    const roots = [
      screen('First', `${instance('One')}${instance('Two')}`),
      screen('Second', instance('Three')),
    ];
    const plan = buildMultiScreenReusePlan(client, roots);
    const report = completeMultiScreenReuseReport(plan, { createdComponents: 0 });

    assert.doesNotThrow(() => assertMultiScreenReuseAcceptance(plan));
    assert.deepEqual(plan.components, [{
      entity: 'ui.card', instances: 3, rootIndexes: [0, 1], firstRoot: 0,
    }]);
    assert.deepEqual(report.summary, {
      reusedComponents: 1,
      reusedInstances: 3,
      createdComponents: 0,
      approvedFlatRepetitions: 0,
    });
  });

  test('keeps explicit vertical review layouts available', () => {
    const plan = buildMultiScreenReusePlan(new FigmaClient(), [
      screen('First', '<Text>One</Text>'),
      screen('Second', '<Text>Two</Text>'),
    ], {
      direction: 'col', placement: { smart: true, x: null, y: null },
    });
    assert.deepEqual(plan.placement, {
      direction: 'col', startsRightOfOccupiedCanvas: false, explicitVertical: true,
    });
    assert.doesNotThrow(() => assertMultiScreenReuseAcceptance(plan));
  });
});
