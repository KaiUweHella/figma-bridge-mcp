import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  semanticRenderArgvRoute,
} from '../src/application/semantic-render-request.js';
import { designEntityRegistryProjection } from '../src/lib/design-link-registry.js';
import { FigmaClient } from '../src/lib/jsx-render.js';
import {
  formatSemanticRenderGuidance,
  SEMANTIC_RENDER_GUIDANCE_CONTRACT,
} from '../src/lib/semantic-render-guidance.js';
import { inspectStructuredRenderPlan } from '../src/lib/structured-render-executor.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('generated Render guidance commands and JSX cross the current request and plan boundaries', () => {
  const client = new FigmaClient();
  client.setDesignEntityProjection(designEntityRegistryProjection({
    version: 1,
    entities: [{
      id: 'ui.card', kind: 'component',
      figma: { componentKey: 'PUBLISHED_CARD', nodeId: '1:2', fileKey: 'FILE_A' },
    }],
  }, { targetFileKey: 'FILE_A' }));
  const formatted = formatSemanticRenderGuidance();

  for (const command of SEMANTIC_RENDER_GUIDANCE_CONTRACT.commands) {
    const plan = planFigmaCommand(command.argv, { workspaceDir: ROOT });
    assert.deepEqual(plan.argv.slice(0, command.argv.length), command.argv, command.id);
    assert.match(formatted, new RegExp(JSON.stringify(command.argv).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (command.argv[0] === 'render') {
      assert.equal(semanticRenderArgvRoute(command.argv).kind, 'compatibility');
    }
  }

  for (const example of SEMANTIC_RENDER_GUIDANCE_CONTRACT.jsxExamples) {
    const route = semanticRenderArgvRoute(['render', example.jsx]);
    assert.ok(['simple', 'compound'].includes(route.kind), example.id);
    assert.equal(client.planJSX(example.jsx).kind, 'figma-bridge/semantic-render-plan');
    assert.match(formatted, new RegExp(example.jsx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('image placeholder guidance is the native preflight fact and truthful degraded Outcome', () => {
  const contract = SEMANTIC_RENDER_GUIDANCE_CONTRACT;
  const placeholder = contract.jsxExamples.find((example) => example.id === 'intentional-image-placeholder');
  const support = inspectStructuredRenderPlan(new FigmaClient().planJSX(placeholder.jsx));

  assert.equal(support.supported, false);
  assert.ok(support.problems.some((problem) => problem.endsWith(contract.facts.image.missingSourceFact)));
  assert.equal(contract.facts.image.missingSourceExecutor, 'generated-eval-compatibility');
  assert.equal(contract.facts.image.missingSourceStatus, 'completed-with-findings');
  assert.match(formatSemanticRenderGuidance(), /never claim\s+native or pixel-exact image fidelity/i);
});

test('README, packaged skill, and MCP guide share executable Instance and Image semantics', async () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const readme = read('../../README.md');
  const skill = read('../../skills/figma-bridge-code-to-figma/SKILL.md');
  const { workflowGuideFor } = await import('../../src/server.js');
  const guide = workflowGuideFor('workflow:code-to-figma');

  for (const [label, source] of [['README', readme], ['skill', skill], ['MCP guide', guide]]) {
    assert.doesNotMatch(source, /<Instance\s+component=/, `${label} advertises name-based Instance identity`);
    assert.match(source, /<Instance\s+entity=|Design Entity/, `${label} omits Design Entity identity`);
    assert.match(source, /completed-with-findings/, `${label} omits degraded Image placeholder status`);
    assert.match(source, /compatibility executor|generated-eval-compatibility/, `${label} omits Image executor truth`);
  }
});

test('generated examples only use props admitted by the element-specific contract', () => {
  const contract = SEMANTIC_RENDER_GUIDANCE_CONTRACT;
  assert.ok(contract.propReferences.Instance.props.includes(contract.facts.instance.identityProp));
  assert.ok(contract.propReferences.Image.props.includes(contract.facts.image.sourceProp));
  assert.deepEqual(contract.facts.instance.forbiddenIdentityProps, ['component', 'id', 'key']);
  assert.deepEqual(contract.propReferences.Instance.dynamicPrefixes, ['prop:', 'text:', 'fill:', 'swap:']);
});
