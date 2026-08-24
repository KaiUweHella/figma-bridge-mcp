// Value-returning native Figma Inspect CSS Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { formatNodeCss, nodeCssCode } from '../lib/native-node-data.js';
import {
  nodeCssArgvFromRequest,
  nodeCssPlanningArgvFromRequest,
  parseNodeCssRequest,
} from './node-css-request.js';

export { nodeCssArgvFromRequest, nodeCssPlanningArgvFromRequest } from './node-css-request.js';

const NODE_CSS_APPLICATION_ID = 'node.css';

function normalizedRequest(request) {
  return parseNodeCssRequest(nodeCssArgvFromRequest(request));
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeNodeCss(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeNodeCss requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const result = await adapters.evaluate(nodeCssCode(input.nodeId));
  return {
    stdout: formatNodeCss(result, { json: input.json }),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result,
  };
}

export function nodeCssPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node CSS routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_CSS_APPLICATION_ID
    ? 'command-application'
    : 'not-node-css';
}

export async function executeNodeCssPlan(plan, adapters = {}) {
  if (nodeCssPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Node CSS Command Application.`);
  }
  return executeNodeCss(parseNodeCssRequest(plan.argv), adapters);
}
