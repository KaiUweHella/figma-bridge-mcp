// Bounded Figma Slides batch operations: one plan, optionally applied.
//
// Every item is resolved and validated against a single grid snapshot before
// anything is written, so the plan a caller reads is the plan that would run.
// Without `--apply` nothing is written at all. With it, items are applied in
// order, each verified by a fresh readback, and the first failure reverses
// everything already applied -- there is no partial success, only a verified
// batch or a reported rollback.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { SLIDE_LABEL_KEY, slideDeckFactsFragment } from '../lib/slides-snippets.js';
import {
  MAX_SLIDES_BATCH_ITEMS,
  parseSlidesBatchRequest,
} from './slides-batch-request.js';

const APPLICATION_ID = 'slides.batch';
export const MAX_SLIDES_BATCH_RESULT_CODE_UNITS = 2_000_000;

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function slidesBatchCode(request) {
  const items = request.items.map((item) => ({
    index: item.index,
    op: item.op,
    reference: item.reference ? { kind: item.reference.kind, value: item.reference.value } : null,
    label: item.label,
    row: item.row,
    col: item.col,
  }));
  return `(async () => {
    const schemaVersion = 1;
    const input = ${jsValue(items)};
    const apply = ${request.apply === true};
    const labelKey = ${jsValue(SLIDE_LABEL_KEY)};
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_BATCH_RESULT_CODE_UNITS}) {
        throw new Error('Slides Batch result exceeded its bounded response limit.');
      }
      return serialized;
    };
    ${slideDeckFactsFragment()}

    // Reference discrimination mirrors the single-slide commands: an id or a
    // literal name/label match, a substring only for a bare query, and any
    // ambiguity refuses the whole batch rather than picking a slide.
    const resolveReference = async (reference, slides) => {
      if (reference.kind === 'node' || reference.kind === 'query') {
        let byId = null;
        try { byId = await figma.getNodeByIdAsync(reference.value); } catch { byId = null; }
        if (byId && byId.type === 'SLIDE') return { status: 'ok', slide: byId };
        if (reference.kind === 'node') {
          return { status: byId ? 'wrong-type' : 'not-found', type: byId ? byId.type : null };
        }
      }
      const exactMatches = reference.kind === 'name'
        ? slides.filter((slide) => slide.name === reference.value)
        : reference.kind === 'label'
          ? slides.filter((slide) => __deckLabel(slide) === reference.value)
          : slides.filter((slide) => slide.name === reference.value
            || __deckLabel(slide) === reference.value);
      if (exactMatches.length === 1) return { status: 'ok', slide: exactMatches[0] };
      if (exactMatches.length > 1) return { status: 'ambiguous', count: exactMatches.length };
      if (reference.kind === 'query') {
        const lower = reference.value.toLowerCase();
        const fuzzy = slides.filter((slide) => slide.name.toLowerCase().includes(lower)
          || __deckLabel(slide).toLowerCase().includes(lower));
        if (fuzzy.length === 1) return { status: 'ok', slide: fuzzy[0] };
        if (fuzzy.length > 1) return { status: 'ambiguous', count: fuzzy.length };
      }
      return { status: 'not-found' };
    };

    const refusal = (item, reason, detail) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: { index: item.index, op: item.op, reason, detail },
    });

    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      if (apply && (typeof figma.createSlide !== 'function'
        || typeof figma.moveNodesToCoord !== 'function'
        || typeof figma.getNodeByIdAsync !== 'function')) {
        return result({ schemaVersion, status: 'invalid-runtime' });
      }

      const deck = __deckRead();
      const rowLengths = deck.rows.map((row) => row.length);
      const planned = [];
      const targets = [];

      for (const item of input) {
        let target = null;
        if (item.reference) {
          const found = await resolveReference(item.reference, deck.slides);
          if (found.status !== 'ok') {
            return refusal(item, found.status,
              item.reference.kind + ':' + item.reference.value);
          }
          target = found.slide;
        }

        // Coordinates are checked against the pre-batch grid, never against a
        // grid this batch would itself produce: simulating Figma's insertion
        // semantics would let a subtly wrong model authorize a wrong write.
        // A coordinate that only becomes valid because of an earlier item is
        // therefore refused, and the reason says so.
        // Only create may establish a new row, as the createSlide contract
        // documents; duplicate and move address rows that already exist.
        if (item.row !== null) {
          const maxRow = item.op === 'create' ? rowLengths.length : rowLengths.length - 1;
          if (item.row > maxRow) {
            return refusal(item, 'row-out-of-range',
              'row ' + item.row + ' exceeds ' + maxRow + ' in the pre-batch grid');
          }
          if (item.col !== null) {
            const existing = item.row < rowLengths.length ? rowLengths[item.row] : 0;
            const maxCol = item.op === 'create' ? existing : Math.max(0, existing - 1);
            if (item.col > maxCol) {
              return refusal(item, 'col-out-of-range',
                'col ' + item.col + ' exceeds ' + maxCol + ' in row ' + item.row
                + ' of the pre-batch grid; a coordinate that depends on an earlier'
                + ' item in the same batch is not planned');
            }
          }
        }

        const facts = target ? __deckFacts(target) : null;
        planned.push({
          index: item.index,
          op: item.op,
          targetId: target ? target.id : null,
          targetLabel: facts ? facts.label : null,
          targetName: facts ? facts.name : null,
          fromRow: facts ? facts.row : null,
          fromCol: facts ? facts.col : null,
          row: item.row,
          col: item.col,
          label: item.label,
        });
        targets.push(target);
      }

      if (!apply) {
        return result({
          schemaVersion,
          status: 'planned',
          // A created or cloned slide has no id before it exists, so the plan
          // states resolved targets and destinations exactly and says nothing
          // it cannot know.
          items: planned,
          slideCount: deck.slides.length,
        });
      }

      const attempted = [];
      const confirmed = [];
      const applyItem = async (entry, target) => {
        if (entry.op === 'create') {
          const created = entry.row === null
            ? figma.createSlide()
            : figma.createSlide(entry.row, entry.col === null ? undefined : entry.col);
          if (!created || created.type !== 'SLIDE') throw new Error('createSlide returned no slide');
          attempted.push({ ...entry, kind: 'created', id: created.id });
          if (entry.label) created.setPluginData(labelKey, entry.label);
          return created;
        }
        if (entry.op === 'duplicate') {
          const clone = target.clone();
          if (!clone || clone.type !== 'SLIDE') throw new Error('clone returned no slide');
          attempted.push({ ...entry, kind: 'created', id: clone.id });
          if (entry.row !== null) {
            figma.moveNodesToCoord([clone.id], entry.row,
              entry.col === null ? undefined : entry.col);
          }
          if (entry.label) clone.setPluginData(labelKey, entry.label);
          return clone;
        }
        attempted.push({ ...entry, kind: 'moved', id: target.id });
        figma.moveNodesToCoord([target.id], entry.row, entry.col);
        return target;
      };

      try {
        for (let index = 0; index < planned.length; index++) {
          const entry = planned[index];
          const node = await applyItem(entry, targets[index]);
          // Fresh readback per item: the grid is authoritative, not the
          // return value of the mutation that changed it.
          __deckRead();
          const facts = __deckFacts(node);
          // Figma's canvas grid does not always list a slide in the same eval
          // that created or moved it. An unobserved coordinate is a gap in what
          // can be checked, not a contradiction, so it is reported rather than
          // rolled back; a coordinate that *is* observed and disagrees still is.
          const gridObserved = facts.row !== null;
          if (gridObserved) {
            if (entry.row !== null && facts.row !== entry.row) {
              throw new Error('slide ' + node.id + ' landed in row ' + facts.row
                + ' instead of ' + entry.row);
            }
            if (entry.col !== null && facts.col !== entry.col) {
              throw new Error('slide ' + node.id + ' landed in col ' + facts.col
                + ' instead of ' + entry.col);
            }
          }
          if (entry.label && facts.label !== entry.label) {
            throw new Error('slide ' + node.id + ' did not keep its Bridge label');
          }
          confirmed.push({ index: entry.index, op: entry.op, id: node.id,
            row: facts.row, col: facts.col, label: facts.label, gridObserved });
        }
      } catch (error) {
        const restored = [];
        const residual = [];
        for (let index = attempted.length - 1; index >= 0; index--) {
          const entry = attempted[index];
          try {
            const node = await figma.getNodeByIdAsync(entry.id);
            if (entry.kind === 'created') {
              if (!node) { restored.push({ index: entry.index, op: entry.op, id: entry.id }); continue; }
              node.remove();
              const after = await figma.getNodeByIdAsync(entry.id);
              if (after) residual.push({ index: entry.index, op: entry.op, id: entry.id, reason: 'restore-failed' });
              else restored.push({ index: entry.index, op: entry.op, id: entry.id });
              continue;
            }
            if (!node || entry.fromRow === null || entry.fromCol === null) {
              residual.push({ index: entry.index, op: entry.op, id: entry.id, reason: 'no-reversal-api' });
              continue;
            }
            // The failing call may never have moved anything. Look first: if
            // the slide is still where it started there is nothing to undo,
            // and re-calling the API that just threw would only obscure that.
            __deckRead();
            const current = __deckFacts(node);
            if (current.row === entry.fromRow && current.col === entry.fromCol) {
              restored.push({ index: entry.index, op: entry.op, id: entry.id });
              continue;
            }
            figma.moveNodesToCoord([entry.id], entry.fromRow, entry.fromCol);
            __deckRead();
            const back = __deckFacts(node);
            if (back.row === entry.fromRow && back.col === entry.fromCol) {
              restored.push({ index: entry.index, op: entry.op, id: entry.id });
            } else {
              residual.push({ index: entry.index, op: entry.op, id: entry.id, reason: 'restore-failed' });
            }
          } catch {
            residual.push({ index: entry.index, op: entry.op, id: entry.id, reason: 'restore-failed' });
          }
        }
        return result({
          schemaVersion,
          status: 'failed',
          outcome: residual.length ? 'partial-residue' : 'rolled-back',
          attempted: attempted.length,
          confirmed,
          restored,
          residual,
          failure: {
            index: attempted.length ? attempted[attempted.length - 1].index : 0,
            op: attempted.length ? attempted[attempted.length - 1].op : 'create',
            reason: 'execution',
            detail: String((error && error.message) || 'unknown').slice(0, 200),
          },
        });
      }

      return result({
        schemaVersion,
        status: 'applied',
        outcome: 'verified',
        attempted: attempted.length,
        confirmed,
        restored: [],
        residual: [],
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

const NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const OPS = new Set(['create', 'duplicate', 'move']);
const REFUSAL_REASONS = new Set([
  'not-found', 'wrong-type', 'ambiguous', 'row-out-of-range', 'col-out-of-range',
]);

const exact = (value, keys) => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const coordinateOrNull = (value) => value === null
  || (Number.isSafeInteger(value) && value >= 0);

function validPlannedItem(value) {
  if (!exact(value, ['index', 'op', 'targetId', 'targetLabel', 'targetName',
    'fromRow', 'fromCol', 'row', 'col', 'label'])) return false;
  if (!Number.isSafeInteger(value.index) || value.index < 0
    || value.index >= MAX_SLIDES_BATCH_ITEMS) return false;
  if (!OPS.has(value.op)) return false;
  if (value.targetId !== null && (typeof value.targetId !== 'string'
    || !NODE_ID.test(value.targetId))) return false;
  if (value.op === 'create' && value.targetId !== null) return false;
  if (value.op !== 'create' && value.targetId === null) return false;
  for (const key of ['fromRow', 'fromCol', 'row', 'col']) {
    if (!coordinateOrNull(value[key])) return false;
  }
  for (const key of ['targetLabel', 'targetName', 'label']) {
    if (value[key] !== null && typeof value[key] !== 'string') return false;
  }
  return true;
}

function validConfirmed(value) {
  if (!exact(value, ['index', 'op', 'id', 'row', 'col', 'label', 'gridObserved'])) return false;
  if (typeof value.gridObserved !== 'boolean') return false;
  // A coordinate may only be reported when the grid actually showed it.
  if (!value.gridObserved && (value.row !== null || value.col !== null)) return false;
  if (!Number.isSafeInteger(value.index) || value.index < 0) return false;
  if (!OPS.has(value.op)) return false;
  if (typeof value.id !== 'string' || !NODE_ID.test(value.id)) return false;
  if (!coordinateOrNull(value.row) || !coordinateOrNull(value.col)) return false;
  return value.label === null || typeof value.label === 'string';
}

function validResidue(value, withReason) {
  const keys = withReason ? ['index', 'op', 'id', 'reason'] : ['index', 'op', 'id'];
  if (!exact(value, keys)) return false;
  if (!Number.isSafeInteger(value.index) || value.index < 0) return false;
  if (!OPS.has(value.op)) return false;
  if (typeof value.id !== 'string' || !NODE_ID.test(value.id)) return false;
  return !withReason || ['no-reversal-api', 'restore-failed'].includes(value.reason);
}

function validFailure(value) {
  if (!exact(value, ['index', 'op', 'reason', 'detail'])) return false;
  if (!Number.isSafeInteger(value.index) || value.index < 0) return false;
  if (!OPS.has(value.op)) return false;
  if (value.reason !== 'execution' && !REFUSAL_REASONS.has(value.reason)) return false;
  return value.detail === null || (typeof value.detail === 'string' && value.detail.length <= 4096);
}

function validPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (value.status === 'wrong-editor' || value.status === 'invalid-runtime') {
    return Object.keys(value).length === 2;
  }
  if (value.status === 'refused') {
    return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
      && value.outcome === 'no-mutation' && value.attempted === 0
      && validFailure(value.failure);
  }
  if (value.status === 'planned') {
    return exact(value, ['schemaVersion', 'status', 'items', 'slideCount'])
      && Array.isArray(value.items) && value.items.every(validPlannedItem)
      && Number.isSafeInteger(value.slideCount) && value.slideCount >= 0;
  }
  if (value.status === 'applied') {
    if (!exact(value, ['schemaVersion', 'status', 'outcome', 'attempted',
      'confirmed', 'restored', 'residual'])) return false;
    if (value.outcome !== 'verified') return false;
    if (!Array.isArray(value.confirmed) || !value.confirmed.every(validConfirmed)) return false;
    // A verified batch has nothing outstanding, and every attempt confirmed.
    return value.restored.length === 0 && value.residual.length === 0
      && value.attempted === value.confirmed.length;
  }
  if (value.status !== 'failed') return false;
  if (!exact(value, ['schemaVersion', 'status', 'outcome', 'attempted',
    'confirmed', 'restored', 'residual', 'failure'])) return false;
  if (!['rolled-back', 'partial-residue'].includes(value.outcome)) return false;
  if (!Number.isSafeInteger(value.attempted) || value.attempted < 0) return false;
  if (!Array.isArray(value.confirmed) || !value.confirmed.every(validConfirmed)) return false;
  if (!Array.isArray(value.restored) || !value.restored.every((entry) => validResidue(entry, false))) return false;
  if (!Array.isArray(value.residual) || !value.residual.every((entry) => validResidue(entry, true))) return false;
  if (!validFailure(value.failure) || value.failure.reason !== 'execution') return false;
  // The outcome name must match the residue it reports.
  if ((value.outcome === 'partial-residue') !== (value.residual.length > 0)) return false;
  return value.restored.length + value.residual.length === value.attempted;
}

function mutationError(payload) {
  const detail = payload.failure ? payload.failure.detail : null;
  const error = new Error(
    `Slides batch ${payload.status}: ${detail || payload.failure?.reason || 'unknown'}`,
  );
  return Object.assign(error, {
    kind: 'mutation',
    phase: 'plugin-execution',
    outcome: payload.outcome,
    dispatchState: 'failed',
    mutationOutcome: payload.outcome,
    mutationReport: {
      version: 1,
      outcome: payload.outcome,
      attempted: payload.attempted,
      confirmed: Array.isArray(payload.confirmed) ? payload.confirmed.length : 0,
      restored: Array.isArray(payload.restored) ? payload.restored.length : 0,
      residueCount: Array.isArray(payload.residual) ? payload.residual.length : 0,
    },
  });
}

function formatPlan(payload) {
  const lines = [
    `Slides batch plan: ${payload.items.length} item(s) over ${payload.slideCount} slide(s). Nothing was written.`,
    '',
  ];
  for (const item of payload.items) {
    const destination = item.row === null
      ? 'appended at the end'
      : `to [${item.row},${item.col === null ? 'end' : item.col}]`;
    const from = item.targetId
      ? ` ${item.targetLabel || item.targetName} (${item.targetId}) at [${item.fromRow},${item.fromCol}]`
      : '';
    const labelled = item.label ? `, label ${JSON.stringify(item.label)}` : '';
    lines.push(`  ${item.index + 1}. ${item.op}${from} ${destination}${labelled}`);
  }
  lines.push('', 'Re-run with --apply to perform it.');
  return lines.join('\n');
}

function formatApplied(payload) {
  const unsettled = payload.confirmed.filter((item) => !item.gridObserved).length;
  const lines = [`Slides batch applied: ${payload.confirmed.length} item(s) verified.`];
  for (const item of payload.confirmed) {
    const where = item.gridObserved
      ? `at [${item.row},${item.col}]`
      : 'placed (grid position not yet listed by Figma)';
    lines.push(`  ${item.index + 1}. ${item.op} ${item.id} ${where}${item.label ? ` (${item.label})` : ''}`);
  }
  if (unsettled) {
    lines.push('', `${unsettled} item(s) were verified by identity and label; Figma had not listed their grid position yet. Run \`slides manifest\` to read the settled deck.`);
  }
  return lines.join('\n');
}

async function executeParsed(request, adapters) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Batch requires a Figma evaluate adapter.');
  }
  const serialized = await adapters.evaluate(slidesBatchCode(request));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_BATCH_RESULT_CODE_UNITS) {
    throw new Error('Slides Batch returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Slides Batch returned invalid JSON.'); }
  if (!validPayload(payload)) {
    throw new Error('Slides Batch returned an invalid bounded result.');
  }
  if (payload.status === 'wrong-editor') {
    throw new Error('Slides batch requires a Figma Slides deck.');
  }
  if (payload.status === 'invalid-runtime') {
    throw new Error('Slides batch could not read a bounded native deck.');
  }
  if (payload.status === 'refused') {
    const { index, op, reason, detail } = payload.failure;
    throw Object.assign(
      new Error(`Slides batch refused before any write: item ${index + 1} (${op}) ${reason}${detail ? ` for ${detail}` : ''}.`),
      { kind: 'validation', phase: 'preflight', outcome: 'no-mutation', dispatchState: 'not-dispatched' },
    );
  }
  if (payload.status === 'failed') throw mutationError(payload);
  return {
    stdout: payload.status === 'planned' ? formatPlan(payload) : formatApplied(payload),
    stderr: '',
    code: 0,
    result: payload,
  };
}

export function executeSlidesBatch(argv, adapters = {}) {
  return executeParsed(parseSlidesBatchRequest(argv), adapters);
}

export function slidesBatchPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Batch routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-batch';
}

export function executeSlidesBatchPlan(plan, adapters = {}) {
  if (slidesBatchPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Batch.');
  }
  return executeParsed(parseSlidesBatchRequest(plan.argv), adapters);
}
