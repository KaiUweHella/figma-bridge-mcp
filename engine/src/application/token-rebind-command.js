// Bounded, rollback-owned Token Rebind Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseTokenRebindRequest,
  tokenRebindArgvFromRequest,
  tokenRebindPlanningArgvFromRequest,
} from './token-rebind-request.js';

export { tokenRebindArgvFromRequest, tokenRebindPlanningArgvFromRequest } from './token-rebind-request.js';

const APPLICATION_ID = 'tokens.rebind';
const MAX_COLLECTIONS = 10_000;
const MAX_VARIABLES = 100_000;
const MAX_NODES = 20_000;
const MAX_BINDINGS = 100_000;
const MAX_RESULT_ITEMS = 200;
const MAX_STRING = 1024;
export const MAX_TOKEN_REBIND_SERIALIZED_CODE_UNITS = 2_000_000;

function normalizedRequest(request) {
  return parseTokenRebindRequest(tokenRebindArgvFromRequest(request));
}

export function tokenRebindCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.collection)};
    const apply = ${input.apply};
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_STRING} && (empty || value.length > 0);
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_COLLECTIONS}
      || new Set(collections.map((item) => item && item.id)).size !== collections.length
      || collections.some((item) => !item || !validText(item.id, false) || !validText(item.name)
        || item.remote || !Array.isArray(item.variableIds)
        || item.variableIds.length > ${MAX_VARIABLES}
        || new Set(item.variableIds).size !== item.variableIds.length
        || item.variableIds.some((id) => !validText(id, false)))) {
      throw new Error('Token Rebind encountered invalid Collection metadata.');
    }
    const folded = query.toLocaleLowerCase('en-US');
    const direct = collections.filter((item) => item.id === query);
    const exact = collections.filter((item) => item.name.toLocaleLowerCase('en-US') === folded);
    const partial = collections.filter((item) => item.name.toLocaleLowerCase('en-US').includes(folded));
    const matches = direct.length ? direct : exact.length ? exact : partial;
    if (!matches.length) throw new Error('Token Rebind Collection not found.');
    if (matches.length > 1) throw new Error('Token Rebind Collection query is ambiguous.');
    const target = matches[0];
    const targetVariables = [];
    for (let start = 0; start < target.variableIds.length; start += 64) {
      targetVariables.push(...await Promise.all(target.variableIds.slice(start, start + 64)
        .map((id) => figma.variables.getVariableByIdAsync(id))));
    }
    if (targetVariables.some((variable, index) => !variable
      || variable.id !== target.variableIds[index] || variable.remote
      || variable.variableCollectionId !== target.id || !validText(variable.name, false)
      || !validText(variable.resolvedType, false))) {
      throw new Error('Token Rebind could not load exact target Variable membership.');
    }
    const targetByName = new Map();
    for (const variable of targetVariables) {
      if (targetByName.has(variable.name)) {
        throw new Error('Token Rebind target Collection contains duplicate Variable names.');
      }
      targetByName.set(variable.name, variable);
    }
    if (!targetByName.size) throw new Error('Token Rebind target Collection has no Variables.');

    ${input.page
      ? 'const roots = figma.currentPage.children.slice();'
      : `const root = await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)});
         if (!root) throw new Error('Token Rebind root Node not found.');
         if (apply && (root.type === 'PAGE' || root.type === 'DOCUMENT')) {
           throw new Error('Token Rebind apply requires a scoped SceneNode root.');
         }
         const roots = [root];`}
    const nodes = [];
    const seen = new Set();
    const stack = roots.slice().reverse();
    while (stack.length) {
      const node = stack.pop();
      if (!node || !validText(node.id, false) || seen.has(node.id)) continue;
      seen.add(node.id); nodes.push(node);
      if (nodes.length > ${MAX_NODES}) throw new Error('Token Rebind Node traversal limit exceeded.');
      if ('children' in node && Array.isArray(node.children)) {
        for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
      }
    }

    const candidates = [];
    const oldIds = new Set();
    const unsupported = new Set();
    for (const node of nodes) {
      for (const property of ['fills', 'strokes']) {
        if (!(property in node)) continue;
        let paints;
        try { paints = node[property]; } catch { unsupported.add(property + ':unreadable'); continue; }
        if (!Array.isArray(paints)) continue;
        for (let index = 0; index < paints.length; index++) {
          const ref = paints[index]?.boundVariables?.color;
          if (!ref?.id) continue;
          candidates.push({ kind: 'paint', node, property, index, oldId: ref.id });
          oldIds.add(ref.id);
        }
      }
      if (node.boundVariables && typeof node.boundVariables === 'object') {
        for (const [field, ref] of Object.entries(node.boundVariables)) {
          if (field === 'fills' || field === 'strokes') continue;
          if (Array.isArray(ref)) { unsupported.add(field + ':array-binding'); continue; }
          if (!ref?.id) continue;
          candidates.push({ kind: 'scalar', node, field, oldId: ref.id });
          oldIds.add(ref.id);
        }
      }
      if (candidates.length > ${MAX_BINDINGS}) throw new Error('Token Rebind binding limit exceeded.');
    }
    const oldIdList = [...oldIds];
    const oldVariables = [];
    for (let start = 0; start < oldIdList.length; start += 64) {
      oldVariables.push(...await Promise.all(oldIdList.slice(start, start + 64)
        .map((id) => figma.variables.getVariableByIdAsync(id))));
    }
    const oldById = new Map();
    for (let index = 0; index < oldIdList.length; index++) {
      const variable = oldVariables[index];
      if (!variable || variable.id !== oldIdList[index]
        || !validText(variable.name, false) || !validText(variable.resolvedType, false)
        || !validText(variable.variableCollectionId, false)) {
        throw new Error('Token Rebind could not load an exact bound Variable.');
      }
      oldById.set(variable.id, variable);
    }

    const operations = [];
    const missing = new Set();
    const incompatible = new Set();
    const fromIds = new Set();
    for (const candidate of candidates) {
      const oldVariable = oldById.get(candidate.oldId);
      if (oldVariable.variableCollectionId === target.id) continue;
      const replacement = targetByName.get(oldVariable.name);
      if (!replacement) { missing.add(oldVariable.name); continue; }
      if (replacement.resolvedType !== oldVariable.resolvedType
        || (candidate.kind === 'paint' && replacement.resolvedType !== 'COLOR')) {
        incompatible.add(oldVariable.name + ':' + candidate.kind); continue;
      }
      fromIds.add(oldVariable.variableCollectionId);
      operations.push({ ...candidate, oldVariable, replacement });
    }
    const from = [...new Set([...fromIds]
      .map((id) => collections.find((item) => item.id === id)?.name || '(unknown)'))].sort();
    const touchedMap = new Map();
    for (const operation of operations) {
      const current = touchedMap.get(operation.node.id) || {
        id: operation.node.id, name: validText(operation.node.name) ? operation.node.name : '',
        type: validText(operation.node.type, false) ? operation.node.type : 'UNKNOWN', changes: 0,
      };
      current.changes++; touchedMap.set(operation.node.id, current);
    }
    const list = (values) => ({ total: values.length, returned: Math.min(values.length, ${MAX_RESULT_ITEMS}),
      omitted: Math.max(0, values.length - ${MAX_RESULT_ITEMS}), items: values.slice(0, ${MAX_RESULT_ITEMS}) });
    const base = () => ({ schemaVersion: 1, targetCollection: target.name, from,
      nodesWalked: nodes.length, rebindings: operations.length,
      tokens: list([...new Set(operations.map((item) => item.oldVariable.name))].sort()),
      missingInTarget: list([...missing].sort()), incompatible: list([...incompatible].sort()),
      unsupported: list([...unsupported].sort()),
      touched: list([...touchedMap.values()]), applied: apply });
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_TOKEN_REBIND_SERIALIZED_CODE_UNITS}) {
        throw new Error('Token Rebind result exceeded the bounded result limit.');
      }
      return serialized;
    };
    if (!apply || !operations.length) return bounded({ ...base(), status: apply ? 'applied' : 'planned' });

    const journals = [];
    const paintGroups = new Map();
    for (const operation of operations.filter((item) => item.kind === 'paint')) {
      const key = operation.node.id + ':' + operation.property;
      if (!paintGroups.has(key)) paintGroups.set(key, { node: operation.node,
        property: operation.property, operations: [] });
      paintGroups.get(key).operations.push(operation);
    }
    try {
      for (const operation of operations.filter((item) => item.kind === 'scalar')) {
        journals.push({ kind: 'scalar', node: operation.node, field: operation.field,
          oldVariable: operation.oldVariable });
        operation.node.setBoundVariable(operation.field, operation.replacement);
      }
      for (const group of paintGroups.values()) {
        const before = group.node[group.property];
        if (!Array.isArray(before)) throw new Error('Paint property became unavailable during apply.');
        journals.push({ kind: 'paint', node: group.node, property: group.property, before });
        const replacements = new Map(group.operations.map((item) => [item.index, item.replacement]));
        group.node[group.property] = before.map((paint, index) => replacements.has(index)
          ? figma.variables.setBoundVariableForPaint(paint, 'color', replacements.get(index)) : paint);
      }
      const fresh = new Map();
      for (const item of touchedMap.values()) {
        const node = await figma.getNodeByIdAsync(item.id);
        if (!node) throw new Error('Token Rebind postcondition Node disappeared.');
        fresh.set(item.id, node);
      }
      for (const operation of operations) {
        const node = fresh.get(operation.node.id);
        const id = operation.kind === 'paint'
          ? node[operation.property]?.[operation.index]?.boundVariables?.color?.id
          : node.boundVariables?.[operation.field]?.id;
        if (id !== operation.replacement.id) throw new Error('Token Rebind fresh postcondition failed.');
      }
      return bounded({ ...base(), status: 'applied' });
    } catch (error) {
      const rollbackErrors = [];
      for (const journal of journals.reverse()) {
        try {
          if (journal.kind === 'paint') journal.node[journal.property] = journal.before;
          else journal.node.setBoundVariable(journal.field, journal.oldVariable);
        } catch { rollbackErrors.push(journal.node.id); }
      }
      let residue = 0;
      for (const operation of operations) {
        try {
          const node = await figma.getNodeByIdAsync(operation.node.id);
          const id = operation.kind === 'paint'
            ? node?.[operation.property]?.[operation.index]?.boundVariables?.color?.id
            : node?.boundVariables?.[operation.field]?.id;
          if (id !== operation.oldVariable.id) residue++;
        } catch { residue++; }
      }
      return bounded({ ...base(), status: residue || rollbackErrors.length ? 'failed-residue' : 'rolled-back',
        applied: false, failure: 'Token Rebind apply failed.', rollback: {
          attempted: journals.length, errors: rollbackErrors.length, residue,
        } });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validList(value) {
  return value && Number.isSafeInteger(value.total) && value.total >= 0
    && Number.isSafeInteger(value.returned) && value.returned === value.items?.length
    && value.returned <= MAX_RESULT_ITEMS && Number.isSafeInteger(value.omitted)
    && value.total === value.returned + value.omitted;
}

function validPayload(value, input) {
  const failed = value?.status === 'rolled-back' || value?.status === 'failed-residue';
  const keys = ['schemaVersion', 'targetCollection', 'from', 'nodesWalked', 'rebindings',
    'tokens', 'missingInTarget', 'incompatible', 'unsupported', 'touched', 'applied', 'status',
    ...(failed ? ['failure', 'rollback'] : [])];
  const sortedText = (items) => Array.isArray(items)
    && items.every((item, index) => typeof item === 'string' && item.length <= MAX_STRING
      && (index === 0 || items[index - 1] < item));
  return exactKeys(value, keys) && value.schemaVersion === 1
    && ['planned', 'applied', 'rolled-back', 'failed-residue'].includes(value.status)
    && value.applied === (value.status === 'applied')
    && typeof value.targetCollection === 'string' && value.targetCollection.length <= MAX_STRING
    && Number.isSafeInteger(value.nodesWalked) && value.nodesWalked >= 0 && value.nodesWalked <= MAX_NODES
    && Number.isSafeInteger(value.rebindings) && value.rebindings >= 0 && value.rebindings <= MAX_BINDINGS
    && sortedText(value.from)
    && validList(value.tokens) && validList(value.missingInTarget)
    && validList(value.incompatible) && validList(value.unsupported) && validList(value.touched)
    && sortedText(value.tokens.items) && sortedText(value.missingInTarget.items)
    && sortedText(value.incompatible.items) && sortedText(value.unsupported.items)
    && value.touched.items.every((item) => item && typeof item.id === 'string'
      && typeof item.name === 'string' && typeof item.type === 'string'
      && Number.isSafeInteger(item.changes) && item.changes > 0)
    && value.touched.total <= value.rebindings
    && value.touched.items.reduce((total, item) => total + item.changes, 0) <= value.rebindings
    && (!failed || (value.failure === 'Token Rebind apply failed.'
      && exactKeys(value.rollback, ['attempted', 'errors', 'residue'])
      && Number.isSafeInteger(value.rollback.attempted) && value.rollback.attempted >= 0
      && Number.isSafeInteger(value.rollback.errors) && value.rollback.errors >= 0
      && Number.isSafeInteger(value.rollback.residue) && value.rollback.residue >= 0
      && value.rollback.residue <= value.rebindings))
    && (!input.apply ? value.status === 'planned' : value.status !== 'planned');
}

const safe = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '�');

export async function executeTokenRebind(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeTokenRebind requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(tokenRebindCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_TOKEN_REBIND_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Rebind returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Token Rebind returned invalid JSON.'); }
  if (!validPayload(payload, input)) throw new Error('Token Rebind returned an invalid bounded result.');
  const verb = payload.status === 'planned' ? 'Would rebind' : payload.status === 'applied' ? 'Rebound'
    : payload.status === 'rolled-back' ? 'Rebind failed and was rolled back' : 'Rebind failed with residue';
  const lines = [`${verb} ${payload.rebindings} binding(s) on ${payload.touched.total} node(s) → ${safe(payload.targetCollection)}`,
    `walked ${payload.nodesWalked} node(s); tokens: ${payload.tokens.items.map(safe).join(', ') || '(none)'}`];
  for (const item of payload.touched.items) lines.push(`  ${safe(item.id)} ${safe(item.type)} ${safe(item.name)} (${item.changes})`);
  if (payload.touched.omitted) lines.push(`  … ${payload.touched.omitted} more`);
  if (payload.missingInTarget.total) lines.push(`missing counterparts: ${payload.missingInTarget.items.map(safe).join(', ')}`);
  if (payload.incompatible.total) lines.push(`incompatible counterparts: ${payload.incompatible.items.map(safe).join(', ')}`);
  if (payload.unsupported.total) lines.push(`unsupported bindings: ${payload.unsupported.items.map(safe).join(', ')}`);
  if (payload.status === 'planned') lines.push('Re-run with --apply to write it.');
  const stderr = ['rolled-back', 'failed-residue'].includes(payload.status)
    ? `${payload.failure} Rollback residue: ${payload.rollback?.residue ?? 'unknown'}.` : '';
  return { stdout: lines.join('\n'), stderr, result: payload };
}

export function tokenRebindPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Token Rebind routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-token-rebind';
}

export async function executeTokenRebindPlan(plan, adapters = {}) {
  if (tokenRebindPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Rebind.`);
  }
  return executeTokenRebind(parseTokenRebindRequest(plan.argv), adapters);
}
