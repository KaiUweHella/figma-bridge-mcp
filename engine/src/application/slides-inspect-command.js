// Bounded, read-only Figma Slides deck inspection.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  SLIDE_LABEL_KEY,
  TRANSITION_CURVES,
  TRANSITION_STYLES,
  TRANSITION_TIMINGS,
} from '../lib/slides-snippets.js';
import {
  parseSlidesReferenceRequest,
  slidesInspectArgvFromRequest,
} from './slides-reference-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  slidesInspectArgvFromRequest,
  slidesInspectPlanningArgvFromRequest,
} from './slides-reference-request.js';

const APPLICATION_ID = 'slides.inspect';
export const MAX_SLIDES_INSPECT_ROWS = 4_096;
export const MAX_SLIDES_INSPECT_ROW_ENTRIES = 4_096;
export const MAX_SLIDES_INSPECT_GRID_ENTRIES = 50_000;
export const MAX_SLIDES_INSPECT_SLIDES = 50_000;
export const MAX_SLIDES_INSPECT_CHILDREN = 50_000;
export const MAX_SLIDES_INSPECT_MATCHES = 16;
export const MAX_SLIDES_INSPECT_RESULT_CODE_UNITS = 2_000_000;
const MAX_NAME_CODE_UNITS = 4_096;
const MAX_TYPE_CODE_UNITS = 64;
const MAX_TRANSITION_SECONDS = 86_400;

function normalized(request) {
  return parseSlidesReferenceRequest(slidesInspectArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function slidesInspectCode(request) {
  const input = normalized(request);
  const reference = input.reference
    ? { kind: input.reference.kind, value: input.reference.value }
    : null;
  return `(async () => {
    const schemaVersion = 1;
    const reference = ${jsValue(reference)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const transitionStyles = new Set(${jsValue(TRANSITION_STYLES)});
    const transitionCurves = new Set(${jsValue(TRANSITION_CURVES)});
    const transitionTimings = new Set(${jsValue(TRANSITION_TIMINGS)});
    const exact = (value, keys) => value && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const text = (value, maximum, empty = true) => typeof value === 'string'
      && value.length <= maximum && (empty || value.length > 0);
    const integer = (value, maximum) => Number.isSafeInteger(value)
      && value >= 0 && value <= maximum;
    const rounded = (value) => Math.round(value * 10000) / 10000;
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_INSPECT_RESULT_CODE_UNITS}) {
        throw new Error('Slides Inspect result exceeded its bounded response limit.');
      }
      return serialized;
    };
    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function'
        || typeof figma.getNodeByIdAsync !== 'function') {
        return result({ schemaVersion, status: 'invalid-runtime' });
      }
      const grid = figma.getCanvasGrid();
      if (!Array.isArray(grid) || grid.length > ${MAX_SLIDES_INSPECT_ROWS}) {
        return result({ schemaVersion, status: 'invalid-runtime' });
      }
      const rows = [];
      const slides = [];
      const coordinates = new Map();
      const seen = new Set();
      let gridEntries = 0;
      for (let row = 0; row < grid.length; row++) {
        const source = grid[row];
        if (!Array.isArray(source) || source.length > ${MAX_SLIDES_INSPECT_ROW_ENTRIES}) {
          return result({ schemaVersion, status: 'invalid-runtime' });
        }
        gridEntries += source.length;
        if (gridEntries > ${MAX_SLIDES_INSPECT_GRID_ENTRIES}) {
          return result({ schemaVersion, status: 'invalid-runtime' });
        }
        const slideRow = [];
        for (let col = 0; col < source.length; col++) {
          const node = source[col];
          if (!node || node.type !== 'SLIDE') continue;
          if (!validId(node.id) || !text(node.name, ${MAX_NAME_CODE_UNITS})
            || seen.has(node.id) || slides.length >= ${MAX_SLIDES_INSPECT_SLIDES}) {
            return result({ schemaVersion, status: 'invalid-runtime' });
          }
          seen.add(node.id);
          coordinates.set(node.id, { row, col });
          slides.push(node);
          slideRow.push(node);
        }
        rows.push(slideRow);
      }
      const labelOf = (slide) => {
        let label = '';
        try { label = slide.getPluginData(${jsValue(SLIDE_LABEL_KEY)}) || ''; } catch {}
        if (!text(label, ${MAX_NAME_CODE_UNITS})) {
          throw new Error('invalid slide label');
        }
        return label;
      };
      const identity = (slide) => {
        if (!slide || slide.type !== 'SLIDE' || !validId(slide.id)
          || !text(slide.name, ${MAX_NAME_CODE_UNITS})) {
          throw new Error('invalid slide identity');
        }
        return { id: slide.id, name: slide.name, label: labelOf(slide) || null };
      };
      const transitionOf = (slide) => {
        if (typeof slide.getSlideTransition !== 'function') {
          throw new Error('invalid slide transition reader');
        }
        const value = slide.getSlideTransition();
        if (!exact(value, ['style', 'duration', 'curve', 'timing'])
          || !transitionStyles.has(value.style) || !transitionCurves.has(value.curve)
          || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
          || value.duration < 0 || value.duration > ${MAX_TRANSITION_SECONDS}
          || !value.timing || !transitionTimings.has(value.timing.type)) {
          throw new Error('invalid slide transition');
        }
        const timingKeys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
        if (!exact(value.timing, timingKeys)
          || (value.timing.type === 'AFTER_DELAY'
            && (typeof value.timing.delay !== 'number' || !Number.isFinite(value.timing.delay)
              || value.timing.delay < 0 || value.timing.delay > ${MAX_TRANSITION_SECONDS}))) {
          throw new Error('invalid slide transition timing');
        }
        return {
          style: value.style,
          duration: rounded(value.duration),
          curve: value.curve,
          timing: value.timing.type === 'AFTER_DELAY'
            ? { type: value.timing.type, delay: rounded(value.timing.delay) }
            : { type: value.timing.type },
        };
      };
      const facts = (slide) => {
        const base = identity(slide);
        if (!Array.isArray(slide.children)
          || slide.children.length > ${MAX_SLIDES_INSPECT_CHILDREN}
          || typeof slide.isSkippedSlide !== 'boolean') {
          throw new Error('invalid slide facts');
        }
        const coordinate = coordinates.get(slide.id) || { row: null, col: null };
        return {
          ...base,
          row: coordinate.row,
          col: coordinate.col,
          skipped: slide.isSkippedSlide,
          transition: transitionOf(slide),
          childCount: slide.children.length,
        };
      };
      const focused = figma.currentPage.focusedSlide;
      const focusedId = focused == null ? null : focused.id;
      if (focusedId !== null && !validId(focusedId)) {
        return result({ schemaVersion, status: 'invalid-runtime' });
      }
      if (!reference) {
        const data = {
          editor: 'slides',
          focusedId,
          rows: rows.map((row) => row.map(facts)),
          slideCount: slides.length,
        };
        return result({ schemaVersion, status: 'ok', data });
      }
      let target = null;
      if (reference.kind === 'node' || reference.kind === 'query') {
        const byId = await figma.getNodeByIdAsync(reference.value);
        if (byId && byId.type === 'SLIDE') target = byId;
        else if (reference.kind === 'node') {
          if (byId) {
            const type = text(byId.type, ${MAX_TYPE_CODE_UNITS}, false)
              ? byId.type : 'UNKNOWN';
            return result({ schemaVersion, status: 'wrong-type', nodeId: reference.value, type });
          }
          return result({ schemaVersion, status: 'not-found' });
        }
      }
      let matches = [];
      if (!target) {
        matches = reference.kind === 'name'
          ? slides.filter((slide) => slide.name === reference.value)
          : reference.kind === 'label'
            ? slides.filter((slide) => labelOf(slide) === reference.value)
            : slides.filter((slide) => slide.name === reference.value
              || labelOf(slide) === reference.value);
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          return result({
            schemaVersion, status: 'ambiguous', count: matches.length,
            matches: matches.slice(0, ${MAX_SLIDES_INSPECT_MATCHES}).map(identity),
          });
        }
      }
      if (!target && reference.kind === 'query') {
        const lower = reference.value.toLowerCase();
        matches = slides.filter((slide) => slide.name.toLowerCase().includes(lower)
          || labelOf(slide).toLowerCase().includes(lower));
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          return result({
            schemaVersion, status: 'ambiguous', count: matches.length,
            matches: matches.slice(0, ${MAX_SLIDES_INSPECT_MATCHES}).map(identity),
          });
        }
      }
      if (!target) return result({ schemaVersion, status: 'not-found' });
      return result({
        schemaVersion,
        status: 'ok',
        data: { editor: 'slides', focusedId, slide: facts(target) },
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function id(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}

function count(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function transition(value) {
  if (!exact(value, ['style', 'duration', 'curve', 'timing'])
    || !TRANSITION_STYLES.includes(value.style)
    || !TRANSITION_CURVES.includes(value.curve)
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
    || value.duration < 0 || value.duration > MAX_TRANSITION_SECONDS
    || !record(value.timing) || !TRANSITION_TIMINGS.includes(value.timing.type)) return false;
  const keys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
  return exact(value.timing, keys) && (value.timing.type !== 'AFTER_DELAY'
    || (typeof value.timing.delay === 'number' && Number.isFinite(value.timing.delay)
      && value.timing.delay >= 0 && value.timing.delay <= MAX_TRANSITION_SECONDS));
}

function slideIdentity(value) {
  return exact(value, ['id', 'name', 'label']) && id(value.id)
    && text(value.name, MAX_NAME_CODE_UNITS)
    && (value.label === null || text(value.label, MAX_NAME_CODE_UNITS));
}

function slideFacts(value) {
  return exact(value, [
    'id', 'name', 'label', 'row', 'col', 'skipped', 'transition', 'childCount',
  ]) && slideIdentity({ id: value.id, name: value.name, label: value.label })
    && ((value.row === null && value.col === null)
      || (count(value.row, MAX_SLIDES_INSPECT_ROWS - 1)
        && count(value.col, MAX_SLIDES_INSPECT_ROW_ENTRIES - 1)))
    && typeof value.skipped === 'boolean' && transition(value.transition)
    && count(value.childCount, MAX_SLIDES_INSPECT_CHILDREN);
}

function okData(data) {
  if (!record(data) || data.editor !== 'slides'
    || (data.focusedId !== null && !id(data.focusedId))) return false;
  if (exact(data, ['editor', 'focusedId', 'slide'])) return slideFacts(data.slide);
  if (!exact(data, ['editor', 'focusedId', 'rows', 'slideCount'])
    || !Array.isArray(data.rows) || data.rows.length > MAX_SLIDES_INSPECT_ROWS
    || !count(data.slideCount, MAX_SLIDES_INSPECT_SLIDES)) return false;
  let total = 0;
  const ids = new Set();
  for (let row = 0; row < data.rows.length; row++) {
    const slides = data.rows[row];
    if (!Array.isArray(slides) || slides.length > MAX_SLIDES_INSPECT_ROW_ENTRIES) return false;
    let previousCol = -1;
    for (const slide of slides) {
      if (!slideFacts(slide) || slide.row !== row || slide.col <= previousCol
        || ids.has(slide.id)) return false;
      ids.add(slide.id);
      previousCol = slide.col;
      total += 1;
    }
  }
  return total === data.slideCount;
}

function validPayload(value) {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.status !== 'string') return false;
  if (value.status === 'ok') return exact(value, ['schemaVersion', 'status', 'data']) && okData(value.data);
  if (['wrong-editor', 'not-found', 'invalid-runtime'].includes(value.status)) {
    return exact(value, ['schemaVersion', 'status']);
  }
  if (value.status === 'wrong-type') {
    return exact(value, ['schemaVersion', 'status', 'nodeId', 'type'])
      && id(value.nodeId) && text(value.type, MAX_TYPE_CODE_UNITS, false);
  }
  return value.status === 'ambiguous'
    && exact(value, ['schemaVersion', 'status', 'count', 'matches'])
    && count(value.count, MAX_SLIDES_INSPECT_SLIDES) && value.count >= 2
    && Array.isArray(value.matches) && value.matches.length > 0
    && value.matches.length <= MAX_SLIDES_INSPECT_MATCHES
    && value.matches.length <= value.count && value.matches.every(slideIdentity)
    && new Set(value.matches.map((match) => match.id)).size === value.matches.length;
}

function referenceDisplay(reference) {
  return reference ? `${reference.kind}:${reference.value}` : 'deck';
}

function safeDisplay(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ');
}

function statusError(payload, input) {
  const display = safeDisplay(referenceDisplay(input.reference));
  if (payload.status === 'wrong-editor') return new Error('Slides inspect requires a Figma Slides deck.');
  if (payload.status === 'not-found') return new Error(`Slide not found: ${display}`);
  if (payload.status === 'wrong-type') {
    return new Error(`Node ${safeDisplay(payload.nodeId)} is a ${safeDisplay(payload.type)}, not a SLIDE.`);
  }
  if (payload.status === 'ambiguous') {
    const remainder = payload.count - payload.matches.length;
    const suffix = remainder > 0 ? ` (and ${remainder} more)` : '';
    return new Error(`Ambiguous slide reference "${display}": ${payload.matches
      .map((match) => `${safeDisplay(match.label || match.name)} (${safeDisplay(match.id)})`).join(', ')}${suffix}`);
  }
  return new Error('Slides inspect could not read a bounded native deck.');
}

async function executeParsed(input, adapters) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Inspect requires a Figma evaluate adapter.');
  }
  const request = { reference: input.reference
    ? `${input.reference.kind}:${input.reference.value}` : null };
  const serialized = await adapters.evaluate(slidesInspectCode(request));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_INSPECT_RESULT_CODE_UNITS) {
    throw new Error('Slides Inspect returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Slides Inspect returned invalid JSON.'); }
  if (!validPayload(payload)) {
    throw new Error('Slides Inspect returned an invalid bounded result.');
  }
  if (payload.status !== 'ok') throw statusError(payload, input);
  return {
    stdout: JSON.stringify(payload.data, null, 2),
    stderr: '',
    code: 0,
    result: payload.data,
  };
}

export function executeSlidesInspect(request, adapters = {}) {
  return executeParsed(normalized(request), adapters);
}

export function slidesInspectPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Inspect routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-inspect';
}

export function executeSlidesInspectPlan(plan, adapters = {}) {
  if (slidesInspectPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Inspect.');
  }
  return executeParsed(parseSlidesReferenceRequest(plan.argv), adapters);
}
