// Value-returning structural and named-version History Command Application.
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { buildSnapshotEval, normalizeSnapshot } from '../lib/doc-snapshot.js';
import { diffSnapshots, formatDiff, formatChangelog, isEmptyDiff } from '../lib/doc-diff.js';
import { snapshotStore } from '../lib/snapshot-store.js';
import {
  historyArgvFromRequest,
  historyPlanningArgvFromRequest,
  MAX_VERSION_DESCRIPTION_CODE_UNITS,
  MAX_VERSION_TITLE_CODE_UNITS,
  parseHistoryRequest,
} from './history-request.js';

export { historyArgvFromRequest, historyPlanningArgvFromRequest } from './history-request.js';

const HISTORY_APPLICATION_IDS = new Set([
  'history.save', 'history.snapshot', 'history.list', 'history.diff',
]);
export const MAX_VERSION_SAVE_ID_CODE_UNITS = 1_024;
export const MAX_VERSION_SAVE_RESULT_CODE_UNITS = 16_384;
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function versionHistorySaveCode(request) {
  const input = parseHistoryRequest(historyArgvFromRequest(request));
  if (input.action !== 'save') throw new Error('Expected a History Save request.');
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const saved = await figma.saveVersionHistoryAsync(request.title, request.description || undefined);
    const id = saved && typeof saved.id === 'string' ? clean(saved.id, ${MAX_VERSION_SAVE_ID_CODE_UNITS}) : null;
    const serialized = JSON.stringify({ id, title: request.title, description: request.description });
    if (serialized.length > ${MAX_VERSION_SAVE_RESULT_CODE_UNITS}) throw new Error('History Save result exceeded its bounded response limit.');
    return serialized;
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed',
  });
  return error;
}
function safe(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ');
}

async function executeSave(request, { evaluate }) {
  const serialized = await evaluate(versionHistorySaveCode(request));
  if (typeof serialized !== 'string' || serialized.length > MAX_VERSION_SAVE_RESULT_CODE_UNITS) {
    throw invalid('History Save returned an invalid bounded result.');
  }
  let result;
  try { result = JSON.parse(serialized); } catch { throw invalid('History Save returned invalid JSON.'); }
  if (!exact(result, ['id', 'title', 'description'])
    || result.title !== request.title || result.description !== request.description
    || !text(result.title, MAX_VERSION_TITLE_CODE_UNITS, false)
    || !(result.description === null || text(result.description, MAX_VERSION_DESCRIPTION_CODE_UNITS))
    || !(result.id === null || text(result.id, MAX_VERSION_SAVE_ID_CODE_UNITS, false))) {
    throw invalid('History Save returned an invalid bounded result.');
  }
  const lines = [
    `✓ Saved Figma version "${safe(result.title)}"${result.id ? ` (${safe(result.id)})` : ''}`,
    ...(result.description ? [`  ${safe(result.description)}`] : []),
  ];
  return { stdout: lines.join('\n'), stderr: '', code: 0, result };
}

function bytes(value) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} kB`;
}

async function capture(request, evaluate) {
  const raw = await evaluate(buildSnapshotEval({
    nodeId: request.nodeId || null,
    depth: request.depth,
  }));
  if (raw?.error === 'NOT_FOUND') throw new Error(`Node ${request.nodeId} was not found in the targeted file.`);
  return normalizeSnapshot(raw, { label: request.label || null });
}

async function currentFileKey(evaluate) {
  const value = await evaluate('(async () => figma.fileKey || null)()');
  if (value !== null && typeof value !== 'string') throw new Error('History received an invalid file identity.');
  return value;
}

async function executeSnapshot(request, { evaluate, store }) {
  const snapshot = await capture(request, evaluate);
  if (request.format === 'json') {
    return { stdout: JSON.stringify(snapshot, null, 2), stderr: '', code: 0, result: snapshot };
  }
  const saved = store.save(snapshot);
  const lines = [
    `Snapshot saved — ${snapshot.nodeCount} nodes, ${bytes(saved.bytes)}`,
    `root: ${snapshot.rootName} (${snapshot.rootId})`,
    ...(snapshot.label ? [`label: ${snapshot.label}`] : []),
    `ref: ${saved.file}`,
    ...(saved.pruned.length ? [`pruned ${saved.pruned.length} older snapshot(s)`] : []),
    '',
    'Diff against it later with: figma_run ["history","diff","latest","live"]',
  ];
  return {
    stdout: lines.join('\n'), stderr: '', code: 0,
    result: {
      snapshot,
      saved: { ref: saved.file, bytes: saved.bytes, pruned: saved.pruned },
    },
  };
}

async function executeList({ evaluate, store }) {
  const fileKey = await currentFileKey(evaluate);
  const refs = store.list(fileKey);
  if (!refs.length) {
    return {
      stdout: 'No snapshots yet for this file.\nRecord one with: figma_run ["history","snapshot"]',
      stderr: '', code: 0, result: { count: 0, snapshots: [] },
    };
  }
  const snapshots = refs.map((ref, index) => {
    let metadata = {};
    try { metadata = store.read(ref); } catch { /* keep a bounded unreadable entry visible */ }
    return {
      index,
      takenAt: metadata.takenAt || ref.file,
      nodeCount: metadata.nodeCount ?? null,
      bytes: ref.bytes,
      label: metadata.label || null,
    };
  });
  const rows = snapshots.map((item) => [
    String(item.index).padStart(2), item.takenAt,
    `${item.nodeCount ?? '?'} nodes`, bytes(item.bytes), item.label || '',
  ].filter(Boolean).join('  '));
  return {
    stdout: `${snapshots.length} snapshot(s) stored locally\n\n  ${rows.join('\n  ')}\n\n`
      + 'Refer to these by index, by "latest"/"previous", or by filename.',
    stderr: '', code: 0, result: { count: snapshots.length, snapshots },
  };
}

async function executeDiff(request, { evaluate, store, workspaceIO }) {
  const fileKey = await currentFileKey(evaluate);
  const load = async (ref, side) => {
    if (ref === 'live') return capture({ ...request, label: 'live' }, evaluate);
    const descriptor = store.resolve(ref, fileKey);
    if (!descriptor) {
      const count = store.list(fileKey).length;
      const hint = count
        ? `${count} available; list them with: figma_run ["history","list"]`
        : 'There are no snapshots for this file yet — run: figma_run ["history","snapshot"]';
      throw new Error(`No snapshot matches ${JSON.stringify(ref)} (${side} side). ${hint}`);
    }
    try { return store.read(descriptor); }
    catch (error) { throw new Error(`Could not read snapshot ${descriptor.file}: ${error.message}`); }
  };
  const before = await load(request.from, 'from');
  const after = await load(request.to, 'to');
  if (before.takenAt === after.takenAt && before.source === after.source
    && request.from !== 'live' && request.to !== 'live') {
    throw new Error(`Both refs resolve to the same snapshot (${before.takenAt}). Pass two different refs, or use live.`);
  }
  const diff = diffSnapshots(before, after);
  if (request.format === 'json') {
    return { stdout: JSON.stringify({ summary: diff.summary, ...diff }, null, 2), stderr: '', code: 0, result: diff };
  }
  if (request.format === 'changelog') {
    const markdown = formatChangelog(diff, { before, after });
    if (request.changelogPath) {
      if (!workspaceIO) throw new TypeError('History changelog persistence requires Workspace I/O.');
      workspaceIO.write(request.changelogPath, `${markdown}\n`, {
        role: 'history-changelog', createParents: true,
      });
      return {
        stdout: `Changelog written to ${request.changelogPath}`,
        stderr: '', code: 0, result: diff,
      };
    }
    return { stdout: markdown, stderr: '', code: 0, result: diff };
  }
  return {
    stdout: formatDiff(diff, { before, after, maxPerSection: request.maxItems }),
    stderr: '', code: isEmptyDiff(diff) ? 0 : 1, result: diff,
  };
}

export async function executeHistory(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeHistory requires evaluate(code).');
  const input = parseHistoryRequest(historyArgvFromRequest(request));
  if (input.action === 'save') return executeSave(input, adapters);
  const store = adapters.store || snapshotStore;
  if (!store || typeof store.resolve !== 'function') throw new TypeError('executeHistory requires a Snapshot Store.');
  if (input.action === 'snapshot') return executeSnapshot(input, { ...adapters, store });
  if (input.action === 'list') return executeList({ ...adapters, store });
  if (input.action === 'diff') return executeDiff(input, { ...adapters, store });
  throw new Error(`Unsupported History action ${input.action}.`);
}

export function historyPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('History routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && HISTORY_APPLICATION_IDS.has(plan.id)
    ? 'command-application'
    : 'not-history';
}

export function executeHistoryPlan(plan, adapters = {}) {
  if (historyPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the History Command Application.`);
  }
  const request = parseHistoryRequest(plan.argv);
  if (request.action === 'diff' && request.changelogPath) {
    const outputs = plan.outputs.filter((output) => output.role === 'history-output');
    if (outputs.length !== 1 || outputs[0].path !== request.changelogPath) {
      throw new Error('History changelog path is not owned by the Command Plan.');
    }
  }
  return executeHistory(request, adapters);
}
