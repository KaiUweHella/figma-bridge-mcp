// Value-returning Node Tree Command Application.
//
// Commander and MCP are adapters at this seam. The closed request, bounded
// traversal, truthful failure and output projection live in this Module.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  nodeTreeArgvFromRequest,
  nodeTreePlanningArgvFromRequest,
  parseNodeTreeRequest,
} from './node-tree-request.js';

export { nodeTreeArgvFromRequest, nodeTreePlanningArgvFromRequest } from './node-tree-request.js';

const NODE_TREE_APPLICATION_ID = 'node.tree';
// 1,500 × 512 code units stays comfortably below the 5 MiB Plugin protocol
// cap even when every retained code point needs four UTF-8 bytes and the
// result carries JSON framing.
export const MAX_NODE_TREE_LINES = 1500;
export const MAX_NODE_TREE_LINE_CODE_UNITS = 512;

function normalizedRequest(request) {
  return parseNodeTreeRequest(nodeTreeArgvFromRequest(request));
}

export function nodeTreeCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const MAX_LINES = ${MAX_NODE_TREE_LINES};
    const MAX_LABEL = 160;
    const maxDepth = ${input.depth};
    const WITH_IDS = ${input.withIds};
    const targetId = ${input.nodeId ? JSON.stringify(input.nodeId) : 'null'};
    const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
    if (!root) throw new Error('Node not found in the targeted Figma document: ' + targetId);
    if (root.type === 'DOCUMENT') await figma.loadAllPagesAsync();
    else if (typeof root.loadAsync === 'function') await root.loadAsync();

    const lines = [];
    let hiddenByDepth = 0;
    let outputTruncated = false;
    const oneLine = (value, limit = MAX_LABEL) => {
      const safe = String(value == null ? '' : value)
        .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g, ' ');
      return safe.length > limit ? safe.slice(0, Math.max(0, limit - 1)) + '…' : safe;
    };
    const push = (line) => {
      if (lines.length >= MAX_LINES) { outputTruncated = true; return false; }
      lines.push(oneLine(line, ${MAX_NODE_TREE_LINE_CODE_UNITS}));
      return true;
    };
    async function printNode(node, indent = 0, depth = 0) {
      if (outputTruncated || depth > maxDepth) return;
      const prefix = '  '.repeat(Math.min(indent, maxDepth));
      const size = node.width && node.height ? ' (' + Math.round(node.width) + 'x' + Math.round(node.height) + ')' : '';
      let label = oneLine(node.type, 48) + ': ' + oneLine(node.name) + size;
      if (WITH_IDS) label += ' [' + oneLine(node.id, 96) + ']';
      if (node.type === 'TEXT') {
        const characters = oneLine(node.characters, 60);
        label += ' "' + characters + '"';
      }
      if (node.type === 'INSTANCE') {
        try {
          const main = await node.getMainComponentAsync();
          if (main && main.name !== node.name) label += ' → ' + oneLine(main.name);
        } catch {}
      }
      if (!push(prefix + label)) return;
      if ('children' in node && node.children.length > 0) {
        if (depth < maxDepth) {
          for (const child of node.children) {
            await printNode(child, indent + 1, depth + 1);
            if (outputTruncated) break;
          }
        } else {
          hiddenByDepth += node.children.length;
          push(prefix + '  … +' + node.children.length + ' child(ren) below depth ' + maxDepth);
        }
      }
    }
    await printNode(root);
    return { schemaVersion: 1, lines, hiddenByDepth, outputTruncated };
  })()`;
}

function validResult(value) {
  return value && typeof value === 'object' && value.schemaVersion === 1
    && Array.isArray(value.lines) && value.lines.length > 0
    && value.lines.length <= MAX_NODE_TREE_LINES
    && value.lines.every((line) => typeof line === 'string'
      && line.length <= MAX_NODE_TREE_LINE_CODE_UNITS)
    && Number.isSafeInteger(value.hiddenByDepth) && value.hiddenByDepth >= 0
    && typeof value.outputTruncated === 'boolean';
}

export function formatNodeTreeResult(result) {
  if (!validResult(result)) throw new Error('Node Tree returned an invalid bounded result.');
  const lines = [...result.lines];
  if (result.hiddenByDepth > 0) {
    lines.push(`(${result.hiddenByDepth} child(ren) hidden by depth limit — re-run with --depth <n>)`);
  }
  if (result.outputTruncated) {
    lines.push(`(tree output truncated at ${MAX_NODE_TREE_LINES} lines — inspect a narrower node or lower depth)`);
  }
  return lines.join('\n');
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeNodeTree(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeNodeTree requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const value = await adapters.evaluate(nodeTreeCode(input));
  return {
    stdout: formatNodeTreeResult(value),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result: value,
  };
}

export function nodeTreePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Tree routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_TREE_APPLICATION_ID
    ? 'command-application'
    : 'not-node-tree';
}

export async function executeNodeTreePlan(plan, adapters = {}) {
  if (nodeTreePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Node Tree Command Application.`);
  }
  return executeNodeTree(parseNodeTreeRequest(plan.argv), adapters);
}
