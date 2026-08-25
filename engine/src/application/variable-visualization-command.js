// Bounded, journaled Variable Visualization Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseVariableVisualizationRequest,
  variableVisualizationArgvFromRequest,
  variableVisualizationPlanningArgvFromRequest,
} from './variable-visualization-request.js';

export { variableVisualizationArgvFromRequest, variableVisualizationPlanningArgvFromRequest } from './variable-visualization-request.js';

const VARIABLE_VISUALIZATION_APPLICATION_ID = 'var.visualize';
const MAX_CANDIDATES = 100_000;
const MAX_COLLECTIONS = 1_000;
const MAX_SWATCHES = 4_096;
const MAX_MODES = 1_000;
const MAX_STRING = 1_024;
export const MAX_VARIABLE_VISUALIZATION_NODES = 12_000;
export const MAX_VARIABLE_VISUALIZATION_SERIALIZED_CODE_UNITS = 1_000_000;

function normalizedRequest(request) {
  return parseVariableVisualizationRequest(variableVisualizationArgvFromRequest(request));
}

export function variableVisualizationCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const collectionQuery = ${JSON.stringify(input.collection)};
    const modeQuery = ${JSON.stringify(input.mode)};
    const [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync('COLOR'),
    ]);
    if (!Array.isArray(collections) || collections.length > ${MAX_CANDIDATES}
      || !Array.isArray(variables) || variables.length > ${MAX_CANDIDATES}) {
      throw new Error('Variable Visualization candidate limit exceeded.');
    }
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_STRING} && (empty || value.length > 0);
    if (new Set(collections.map((item) => item.id)).size !== collections.length
      || new Set(variables.map((item) => item.id)).size !== variables.length) {
      throw new Error('Variable Visualization encountered duplicate native identities.');
    }
    const variablesByCollection = new Map();
    for (const variable of variables) {
      if (!variablesByCollection.has(variable.variableCollectionId)) {
        variablesByCollection.set(variable.variableCollectionId, []);
      }
      variablesByCollection.get(variable.variableCollectionId).push(variable);
    }
    let targets = collections;
    let collectionResolution = 'all';
    if (collectionQuery !== null) {
      const direct = collections.filter((item) => item.id === collectionQuery);
      const exact = collections.filter((item) => item.name === collectionQuery);
      const partial = collections.filter((item) =>
        item.name.toLowerCase().includes(collectionQuery.toLowerCase()));
      const matches = direct.length ? direct : (exact.length ? exact : partial);
      if (matches.length > 1) throw new Error('Variable Collection is ambiguous; use its id.');
      if (!matches.length) throw new Error('Variable Collection not found.');
      targets = matches;
      collectionResolution = direct.length ? 'id' : 'name';
    }
    if (targets.length > ${MAX_COLLECTIONS}) throw new Error('Variable Visualization Collection limit exceeded.');
    const semanticGroups = {
      background: 'base', foreground: 'base', border: 'base', input: 'base', ring: 'base',
      primary: 'primary', 'primary-foreground': 'primary', secondary: 'secondary',
      'secondary-foreground': 'secondary', muted: 'muted', 'muted-foreground': 'muted',
      accent: 'accent', 'accent-foreground': 'accent', card: 'card', 'card-foreground': 'card',
      popover: 'popover', 'popover-foreground': 'popover', destructive: 'destructive',
      'destructive-foreground': 'destructive', 'chart-1': 'chart', 'chart-2': 'chart',
      'chart-3': 'chart', 'chart-4': 'chart', 'chart-5': 'chart',
    };
    const colorOrder = ['slate','gray','zinc','neutral','stone','red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose','white','black'];
    const semanticOrder = ['base','primary','secondary','muted','accent','card','popover','destructive','chart','sidebar'];
    const plans = [];
    let swatchCount = 0;
    let unresolvedCount = 0;
    let plannedNodeCount = 0;
    for (const collection of targets) {
      if (!validText(collection.id, false) || !validText(collection.name) || collection.remote
        || !validText(collection.defaultModeId, false) || !Array.isArray(collection.modes)
        || collection.modes.length < 1 || collection.modes.length > ${MAX_MODES}
        || collection.modes.some((mode) => !mode || !validText(mode.modeId, false) || !validText(mode.name))
        || new Set(collection.modes.map((mode) => mode.modeId)).size !== collection.modes.length
        || !collection.modes.some((mode) => mode.modeId === collection.defaultModeId)) {
        throw new Error('Variable Visualization encountered invalid Collection metadata.');
      }
      let mode = collection.modes.find((item) => item.modeId === collection.defaultModeId);
      let modeResolution = 'default';
      if (modeQuery !== null) {
        const direct = collection.modes.filter((item) => item.modeId === modeQuery);
        const exact = collection.modes.filter((item) => item.name === modeQuery);
        const partial = collection.modes.filter((item) => item.name.toLowerCase().includes(modeQuery.toLowerCase()));
        const matches = direct.length ? direct : (exact.length ? exact : partial);
        if (matches.length > 1) throw new Error('Variable mode is ambiguous; use its id.');
        if (!matches.length) throw new Error('Variable mode not found in one targeted Collection.');
        mode = matches[0];
        modeResolution = direct.length ? 'id' : 'name';
      }
      const owned = variablesByCollection.get(collection.id) || [];
      const groups = new Map();
      let collectionUnresolvedCount = 0;
      for (const variable of owned) {
        if (!validText(variable.id, false) || !validText(variable.name, false) || variable.remote
          || variable.resolvedType !== 'COLOR' || !variable.valuesByMode
          || typeof variable.valuesByMode !== 'object' || Array.isArray(variable.valuesByMode)) {
          throw new Error('Variable Visualization encountered incompatible COLOR Variable facts.');
        }
        const hasValue = Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId);
        if (!hasValue) {
          collectionUnresolvedCount++;
        } else {
          const value = variable.valuesByMode[mode.modeId];
          const alias = value && typeof value === 'object' && !Array.isArray(value)
            && value.type === 'VARIABLE_ALIAS' && validText(value.id, false);
          const color = value && typeof value === 'object' && !Array.isArray(value)
            && ['r', 'g', 'b'].every((key) => typeof value[key] === 'number'
              && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)
            && (value.a === undefined || (typeof value.a === 'number'
              && Number.isFinite(value.a) && value.a >= 0 && value.a <= 1));
          if (!alias && !color) throw new Error('Variable Visualization encountered invalid COLOR mode value.');
        }
        const parts = variable.name.split('/');
        const group = parts.length > 1 ? parts[0]
          : (variable.name.startsWith('sidebar-') ? 'sidebar' : (semanticGroups[variable.name] || 'other'));
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(variable);
      }
      const groupRank = (name) => {
        const color = colorOrder.indexOf(name);
        if (color >= 0) return color;
        const semantic = semanticOrder.indexOf(name);
        return semantic >= 0 ? colorOrder.length + semantic : 10_000;
      };
      const sortedGroups = [...groups].sort((a, b) => groupRank(a[0]) - groupRank(b[0])
        || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [, values] of sortedGroups) values.sort((a, b) => {
        const aNumber = Number.parseInt(a.name.split('/').pop(), 10);
        const bNumber = Number.parseInt(b.name.split('/').pop(), 10);
        const aRank = Number.isFinite(aNumber) ? aNumber : 0;
        const bRank = Number.isFinite(bNumber) ? bNumber : 0;
        return aRank - bRank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
      swatchCount += owned.length;
      unresolvedCount += collectionUnresolvedCount;
      plannedNodeCount += owned.length + sortedGroups.length * 3 + (sortedGroups.length ? 3 : 0);
      plans.push({ collection, mode, modeResolution, groups: sortedGroups,
        colorCount: owned.length, unresolvedCount: collectionUnresolvedCount });
    }
    if (swatchCount > ${MAX_SWATCHES}) throw new Error('Variable Visualization swatch limit exceeded.');
    if (plannedNodeCount > ${MAX_VARIABLE_VISUALIZATION_NODES}) {
      throw new Error('Variable Visualization node limit exceeded.');
    }
    await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
    let startX = 100;
    for (const node of figma.currentPage.children) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.width)) {
        throw new Error('Variable Visualization encountered invalid canvas geometry.');
      }
      startX = Math.max(startX, node.x + node.width + 100);
    }
    const journal = [];
    const containers = [];
    const viewportNodes = [];
    const bindingChecks = [];
    const structureChecks = [];
    const created = (factory) => {
      const node = factory(); journal.push({ node, id: node.id, type: node.type }); return node;
    };
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_VARIABLE_VISUALIZATION_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Visualization result exceeded the bounded result limit.');
      }
      return serialized;
    };
    try {
      for (const plan of plans) {
        if (!plan.groups.length) continue;
        const container = created(() => figma.createFrame());
        container.name = plan.collection.name;
        container.x = startX; container.y = 0; container.layoutMode = 'VERTICAL';
        container.primaryAxisSizingMode = 'AUTO'; container.counterAxisSizingMode = 'AUTO';
        container.itemSpacing = 8; container.paddingTop = 32; container.paddingBottom = 32;
        container.paddingLeft = 32; container.paddingRight = 32; container.cornerRadius = 16;
        container.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        container.setExplicitVariableModeForCollection(plan.collection, plan.mode.modeId);
        const groupChecks = [];
        const title = created(() => figma.createText());
        title.fontName = { family: 'Inter', style: 'Medium' }; title.fontSize = 20;
        title.characters = plan.collection.name;
        title.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
        container.appendChild(title);
        const spacer = created(() => figma.createFrame());
        spacer.resize(1, 16); spacer.fills = []; container.appendChild(spacer);
        let collectionSwatches = 0;
        for (const [groupName, values] of plan.groups) {
          const row = created(() => figma.createFrame());
          row.name = groupName; row.layoutMode = 'HORIZONTAL'; row.primaryAxisSizingMode = 'AUTO';
          row.counterAxisSizingMode = 'AUTO'; row.itemSpacing = 16;
          row.counterAxisAlignItems = 'CENTER'; row.fills = []; container.appendChild(row);
          const label = created(() => figma.createText());
          label.fontName = { family: 'Inter', style: 'Medium' }; label.fontSize = 13;
          label.characters = groupName; label.resize(80, label.height);
          label.textAlignHorizontal = 'RIGHT'; label.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
          row.appendChild(label);
          const swatchRow = created(() => figma.createFrame());
          swatchRow.layoutMode = 'HORIZONTAL'; swatchRow.primaryAxisSizingMode = 'AUTO';
          swatchRow.counterAxisSizingMode = 'AUTO'; swatchRow.itemSpacing = 0;
          swatchRow.fills = []; swatchRow.cornerRadius = 6; swatchRow.clipsContent = true;
          row.appendChild(swatchRow);
          const swatchChecks = [];
          for (const variable of values) {
            const swatch = created(() => figma.createFrame());
            swatch.name = variable.name; swatch.resize(48, 32);
            swatch.fills = [figma.variables.setBoundVariableForPaint(
              { type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }, 'color', variable)];
            swatchRow.appendChild(swatch);
            bindingChecks.push({ swatch, variableId: variable.id });
            swatchChecks.push({ swatch, name: variable.name });
            collectionSwatches++;
          }
          groupChecks.push({ row, label, swatchRow, swatches: swatchChecks });
        }
        if (container.explicitVariableModes[plan.collection.id] !== plan.mode.modeId) {
          throw new Error('Variable Visualization could not verify the explicit mode.');
        }
        containers.push({ id: container.id, name: container.name, collectionId: plan.collection.id,
          modeId: plan.mode.modeId, swatchCount: collectionSwatches });
        structureChecks.push({ container, title, spacer, groupChecks, name: plan.collection.name });
        viewportNodes.push(container);
        startX += container.width + 60;
      }
      if (journal.length !== plannedNodeCount
        || new Set(journal.map((entry) => entry.id)).size !== journal.length) {
        throw new Error('Variable Visualization could not verify its node journal.');
      }
      for (const check of structureChecks) {
        if (check.container.type !== 'FRAME' || check.container.parent !== figma.currentPage
          || check.container.name !== check.name || check.container.layoutMode !== 'VERTICAL'
          || check.container.primaryAxisSizingMode !== 'AUTO'
          || check.container.counterAxisSizingMode !== 'AUTO'
          || check.title.type !== 'TEXT' || check.title.parent !== check.container
          || check.spacer.type !== 'FRAME' || check.spacer.parent !== check.container
          || check.spacer.width !== 1 || check.spacer.height !== 16) {
          throw new Error('Variable Visualization could not verify its root Auto Layout topology.');
        }
        for (const group of check.groupChecks) {
          if (group.row.type !== 'FRAME' || group.row.parent !== check.container
            || group.row.layoutMode !== 'HORIZONTAL'
            || group.row.primaryAxisSizingMode !== 'AUTO'
            || group.row.counterAxisSizingMode !== 'AUTO'
            || group.label.type !== 'TEXT' || group.label.parent !== group.row
            || group.swatchRow.type !== 'FRAME' || group.swatchRow.parent !== group.row
            || group.swatchRow.layoutMode !== 'HORIZONTAL'
            || group.swatchRow.primaryAxisSizingMode !== 'AUTO'
            || group.swatchRow.counterAxisSizingMode !== 'AUTO') {
            throw new Error('Variable Visualization could not verify one group Auto Layout topology.');
          }
          for (const item of group.swatches) {
            if (item.swatch.type !== 'FRAME' || item.swatch.parent !== group.swatchRow
              || item.swatch.name !== item.name || item.swatch.width !== 48 || item.swatch.height !== 32) {
              throw new Error('Variable Visualization could not verify one swatch topology.');
            }
          }
        }
      }
      for (const check of bindingChecks) {
        const paints = check.swatch.fills;
        const binding = Array.isArray(paints) && paints.length === 1
          ? paints[0]?.boundVariables?.color : null;
        if (!binding || binding.type !== 'VARIABLE_ALIAS' || binding.id !== check.variableId) {
          throw new Error('Variable Visualization could not verify one native COLOR binding.');
        }
      }
      try { figma.viewport.scrollAndZoomIntoView(viewportNodes); } catch {}
      const targetFacts = plans.map((plan) => ({
        id: plan.collection.id, name: plan.collection.name,
        collectionResolution, modeId: plan.mode.modeId, modeName: plan.mode.name,
        modeResolution: plan.modeResolution, colorCount: plan.colorCount,
        unresolvedCount: plan.unresolvedCount,
      }));
      return bounded({ schemaVersion: 1, status: 'created', query: {
        collection: collectionQuery, mode: modeQuery,
      }, targets: targetFacts, containers,
        swatchCount: containers.reduce((sum, item) => sum + item.swatchCount, 0),
        unresolvedCount, residue: [] });
    } catch (error) {
      if (!journal.length) throw error;
      const attempted = journal.map((entry) => ({ id: entry.id, type: entry.type }));
      for (let index = journal.length - 1; index >= 0; index--) {
        try { if (!journal[index].node.removed) journal[index].node.remove(); } catch {}
      }
      const residue = journal.filter((entry) => !entry.node.removed)
        .map((entry) => ({ id: entry.id, type: entry.type }));
      return bounded({ schemaVersion: 1, status: 'failed',
        outcome: residue.length ? 'partial-residue' : 'rolled-back',
        attemptedCount: attempted.length, removedCount: attempted.length - residue.length,
        residue, residueTruncated: false });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function text(value, empty = true) { return typeof value === 'string' && value.length <= MAX_STRING && (empty || value.length > 0); }
function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'query', 'targets', 'containers', 'swatchCount', 'unresolvedCount', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created'
    && exactKeys(value.query, ['collection', 'mode'])
    && value.query.collection === input.collection && value.query.mode === input.mode
    && Array.isArray(value.targets) && value.targets.length <= MAX_COLLECTIONS
    && value.targets.every((item) => exactKeys(item, ['id', 'name', 'collectionResolution', 'modeId', 'modeName', 'modeResolution', 'colorCount', 'unresolvedCount'])
      && text(item.id, false) && text(item.name)
      && ['all', 'id', 'name'].includes(item.collectionResolution)
      && text(item.modeId, false) && text(item.modeName)
      && ['default', 'id', 'name'].includes(item.modeResolution)
      && Number.isSafeInteger(item.colorCount) && item.colorCount >= 0
      && Number.isSafeInteger(item.unresolvedCount) && item.unresolvedCount >= 0
      && item.unresolvedCount <= item.colorCount)
    && new Set(value.targets.map((item) => item.id)).size === value.targets.length
    && (input.collection === null
      ? value.targets.every((item) => item.collectionResolution === 'all')
      : value.targets.length === 1 && value.targets[0].collectionResolution !== 'all'
        && (value.targets[0].collectionResolution === 'id'
          ? value.targets[0].id === input.collection
          : value.targets[0].name.toLowerCase().includes(input.collection.toLowerCase())))
    && value.targets.every((item) => input.mode === null
      ? item.modeResolution === 'default'
      : item.modeResolution === 'id' ? item.modeId === input.mode
        : item.modeResolution === 'name'
          && item.modeName.toLowerCase().includes(input.mode.toLowerCase()))
    && Array.isArray(value.containers) && value.containers.length <= MAX_COLLECTIONS
    && value.containers.every((item) => exactKeys(item, ['id', 'name', 'collectionId', 'modeId', 'swatchCount'])
      && text(item.id, false) && text(item.name) && text(item.collectionId, false) && text(item.modeId, false)
      && Number.isSafeInteger(item.swatchCount) && item.swatchCount > 0)
    && new Set(value.containers.map((item) => item.id)).size === value.containers.length
    && new Set(value.containers.map((item) => item.collectionId)).size === value.containers.length
    && value.containers.every((container) => value.targets.some((target) =>
      target.id === container.collectionId && target.modeId === container.modeId
      && target.name === container.name && target.colorCount === container.swatchCount))
    && value.targets.filter((item) => item.colorCount > 0).every((target) =>
      value.containers.filter((container) => container.collectionId === target.id
        && container.modeId === target.modeId && container.name === target.name
        && container.swatchCount === target.colorCount).length === 1)
    && value.containers.length === value.targets.filter((item) => item.colorCount > 0).length
    && Number.isSafeInteger(value.swatchCount) && value.swatchCount >= 0 && value.swatchCount <= MAX_SWATCHES
    && Number.isSafeInteger(value.unresolvedCount) && value.unresolvedCount >= 0
    && value.unresolvedCount <= value.swatchCount
    && value.unresolvedCount === value.targets.reduce((sum, item) => sum + item.unresolvedCount, 0)
    && value.swatchCount === value.targets.reduce((sum, item) => sum + item.colorCount, 0)
    && value.swatchCount === value.containers.reduce((sum, item) => sum + item.swatchCount, 0)
    && Array.isArray(value.residue) && value.residue.length === 0;
}
function validFailure(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attemptedCount', 'removedCount', 'residue', 'residueTruncated'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && Number.isSafeInteger(value.attemptedCount) && value.attemptedCount > 0
    && value.attemptedCount <= MAX_VARIABLE_VISUALIZATION_NODES
    && Number.isSafeInteger(value.removedCount) && value.removedCount >= 0
    && value.removedCount <= value.attemptedCount
    && Array.isArray(value.residue) && value.residue.length <= value.attemptedCount
    && value.residue.length <= MAX_VARIABLE_VISUALIZATION_NODES
    && value.residue.every((item) => exactKeys(item, ['id', 'type'])
      && text(item.id, false) && ['FRAME', 'TEXT'].includes(item.type))
    && new Set(value.residue.map((item) => item.id)).size === value.residue.length
    && value.removedCount + value.residue.length === value.attemptedCount
    && value.residueTruncated === false
    && (value.outcome === 'rolled-back' ? value.residue.length === 0 : value.residue.length > 0);
}

export async function executeVariableVisualization(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeVariableVisualization requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableVisualizationCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_VARIABLE_VISUALIZATION_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Visualization returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Variable Visualization returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw new Error('Variable Visualization returned an invalid bounded result.');
    const error = new Error(payload.outcome === 'rolled-back'
      ? 'Variable Visualization failed; every created canvas node was removed.'
      : 'Variable Visualization failed; one or more created canvas nodes remain.');
    error.kind = 'execution'; error.phase = 'plugin-execution'; error.outcome = 'unknown-after-dispatch';
    error.dispatchState = 'failed'; error.mutationOutcome = payload.outcome;
    error.mutationReport = { version: 1, outcome: payload.outcome, created: payload.attemptedCount,
      removed: payload.removedCount, residueCount: payload.residue.length,
      residue: payload.residue.map((item) => ({ kind: 'node', handle: item.id, reason: 'remove-failed' })),
      residueTruncated: false };
    throw error;
  }
  if (!validSuccess(payload, input)) throw new Error('Variable Visualization returned an invalid bounded result.');
  return { stdout: `Created ${payload.swatchCount} color swatches`, stderr: '', result: payload };
}

export function variableVisualizationPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Variable Visualization routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === VARIABLE_VISUALIZATION_APPLICATION_ID ? 'command-application' : 'not-variable-visualization';
}
export async function executeVariableVisualizationPlan(plan, adapters = {}) {
  if (variableVisualizationPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Visualization.`);
  return executeVariableVisualization(parseVariableVisualizationRequest(plan.argv), adapters);
}
