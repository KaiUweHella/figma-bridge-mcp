// Plan-bound bounded Component Inventory Read Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  componentInventoryCode,
  projectComponentInventory,
} from '../lib/component-inventory.js';
import {
  componentInventoryArgvFromRequest,
  componentInventoryPlanningArgvFromRequest,
  parseComponentInventoryRequest,
} from './component-inventory-request.js';

export {
  componentInventoryArgvFromRequest,
  componentInventoryPlanningArgvFromRequest,
} from './component-inventory-request.js';

const APPLICATION_ID = 'component.list';

function normalizedRequest(request) {
  return parseComponentInventoryRequest(componentInventoryArgvFromRequest(request));
}

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function quoted(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentInventoryResult(result, { json = false } = {}) {
  if (json) return safeJson(result);
  if (result.componentSets.length === 0 && result.standaloneComponents.length === 0) {
    return result.scope === 'ALL_PAGES'
      ? 'No components in this file.'
      : 'No components on the current page. Try --all-pages.';
  }
  const lines = [];
  if (result.componentSets.length > 0) {
    lines.push('Component sets:');
    for (const set of result.componentSets) {
      lines.push(`  ${quoted(set.name)} (${set.id}${result.scope === 'ALL_PAGES' ? `, page: ${quoted(set.page)}` : ''})`);
      if (set.key) lines.push(`    key: ${set.key}`);
      if (set.variantAxes) {
        for (const [axis, definition] of Object.entries(set.variantAxes)) {
          lines.push(`    ${quoted(axis)}: ${definition.values.map(quoted).join(' | ')}`);
        }
      }
      lines.push(`    ${set.variants.length} variant(s)`);
    }
  }
  if (result.standaloneComponents.length > 0) {
    if (lines.length) lines.push('');
    lines.push('Standalone components:');
    for (const component of result.standaloneComponents) {
      lines.push(`  ${quoted(component.name)} (${component.id}`
        + `${result.scope === 'ALL_PAGES' ? `, page: ${quoted(component.page)}` : ''}`
        + `${component.key ? `, key ${component.key}` : ''})`);
    }
  }
  return lines.join('\n');
}

export async function executeComponentInventory(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Inventory requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const payload = projectComponentInventory(
    await adapters.evaluate(componentInventoryCode(input.allPages)),
  );
  if (payload.scope !== (input.allPages ? 'ALL_PAGES' : 'CURRENT_PAGE')) {
    throw new Error('Component Inventory returned a mismatched scan scope.');
  }
  return {
    stdout: formatComponentInventoryResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentInventoryPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Inventory routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-inventory';
}

export async function executeComponentInventoryPlan(plan, adapters = {}) {
  if (componentInventoryPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Inventory.`);
  }
  return executeComponentInventory(parseComponentInventoryRequest(plan.argv), adapters);
}
