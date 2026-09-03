// Figma Slides editor context: which slide is focused, and how the deck is
// viewed.
//
// Neither command changes the document. `PageNode.focusedSlide` and
// `ViewportAPI.slidesView` are both declared as getters *and* setters in
// `@figma/plugin-typings` 1.133, so this is the documented surface rather than
// an emulation -- and because nothing in the file changes, both report
// `effects.figma: 'read'` with `effects.editor: 'write'` and are not gated by
// write confirmation. Both verify by reading the value back.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { SLIDE_LABEL_KEY, slidePageSlidesFragment } from '../lib/slides-snippets.js';
import { parseSlidesReferenceRequest } from './slides-reference-request.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';

const FOCUS_APPLICATION_ID = 'slides.focus';
const VIEW_APPLICATION_ID = 'slides.view';
export const SLIDES_VIEW_MODES = Object.freeze(['grid', 'single-slide']);
export const MAX_SLIDES_VIEWPORT_RESULT_CODE_UNITS = 64_000;

const MODES = new Set(SLIDES_VIEW_MODES);

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function requestError(message) {
  return new Error(`Invalid Slides command: ${message}.`);
}

/** The view mode, validated against the modes the typings declare. */
export function parseSlidesViewRequest(args) {
  const base = parseSlidesReferenceRequest(args);
  if (base.action !== 'view') throw new Error('Expected a Slides view command.');
  const mode = base.argv.slice(2).find((token) => !token.startsWith('-') || token === '-');
  if (!MODES.has(mode)) {
    throw requestError(`view mode must be one of ${SLIDES_VIEW_MODES.join(', ')}`);
  }
  return Object.freeze({ action: 'view', argv: base.argv, mode });
}

export function acceptsSlidesViewArgv(args) {
  try {
    parseSlidesViewRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function slidesFocusCode(request) {
  const reference = { kind: request.reference.kind, value: request.reference.value };
  return `(async () => {
    const schemaVersion = 1;
    const reference = ${jsValue(reference)};
    const labelKey = ${jsValue(SLIDE_LABEL_KEY)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const result = (payload) => JSON.stringify(payload);
    const labelOf = (slide) => {
      try { return slide.getPluginData(labelKey) || ''; } catch { return ''; }
    };
    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function'
        || typeof figma.getNodeByIdAsync !== 'function') {
        return result({ schemaVersion, status: 'invalid-runtime' });
      }
      ${slidePageSlidesFragment()}
      // A grid that throws (it can keep a removed slide's id) must not hide
      // the deck: the page tree below still resolves names and labels.
      let grid;
      try { grid = figma.getCanvasGrid(); } catch { grid = []; }
      if (!Array.isArray(grid)) return result({ schemaVersion, status: 'invalid-runtime' });
      const slides = [];
      for (const row of grid) {
        if (!Array.isArray(row)) return result({ schemaVersion, status: 'invalid-runtime' });
        for (const node of row) if (node && node.type === 'SLIDE') slides.push(node);
      }
      // The grid lags the page tree; a slide it has not listed yet is still
      // addressable by name or label.
      const listed = new Set(slides.map((entry) => entry.id));
      for (const node of __pageSlides()) if (!listed.has(node.id)) slides.push(node);

      let target = null;
      if (reference.kind === 'node' || reference.kind === 'query') {
        let byId = null;
        try { byId = await figma.getNodeByIdAsync(reference.value); } catch { byId = null; }
        if (byId && byId.type === 'SLIDE') target = byId;
        else if (reference.kind === 'node') {
          return result({ schemaVersion, status: byId ? 'wrong-type' : 'not-found' });
        }
      }
      if (!target) {
        const matches = reference.kind === 'name'
          ? slides.filter((slide) => slide.name === reference.value)
          : reference.kind === 'label'
            ? slides.filter((slide) => labelOf(slide) === reference.value)
            : slides.filter((slide) => slide.name === reference.value
              || labelOf(slide) === reference.value);
        if (matches.length > 1) {
          return result({ schemaVersion, status: 'ambiguous', count: matches.length });
        }
        if (matches.length === 1) target = matches[0];
      }
      if (!target && reference.kind === 'query') {
        const lower = reference.value.toLowerCase();
        const fuzzy = slides.filter((slide) => slide.name.toLowerCase().includes(lower)
          || labelOf(slide).toLowerCase().includes(lower));
        if (fuzzy.length > 1) {
          return result({ schemaVersion, status: 'ambiguous', count: fuzzy.length });
        }
        if (fuzzy.length === 1) target = fuzzy[0];
      }
      if (!target) return result({ schemaVersion, status: 'not-found' });

      const before = figma.currentPage.focusedSlide;
      figma.currentPage.focusedSlide = target;
      const after = figma.currentPage.focusedSlide;
      if (!after || after.id !== target.id) {
        return result({ schemaVersion, status: 'refused' });
      }
      const valid = (value) => typeof value === 'string' && nodeIdPattern.test(value);
      if (!valid(after.id)) return result({ schemaVersion, status: 'invalid-runtime' });
      return result({
        schemaVersion,
        status: 'ok',
        data: {
          focusedId: after.id,
          name: typeof target.name === 'string' ? target.name.slice(0, 4096) : '',
          label: labelOf(target) || null,
          previousId: before && valid(before.id) ? before.id : null,
        },
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

export function slidesViewCode(request) {
  return `(async () => {
    const schemaVersion = 1;
    const mode = ${jsValue(request.mode)};
    const result = (payload) => JSON.stringify(payload);
    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      if (!figma.viewport) return result({ schemaVersion, status: 'invalid-runtime' });
      const before = figma.viewport.slidesView;
      figma.viewport.slidesView = mode;
      const after = figma.viewport.slidesView;
      if (after !== mode) return result({ schemaVersion, status: 'refused' });
      return result({
        schemaVersion,
        status: 'ok',
        data: {
          mode: after,
          previousMode: typeof before === 'string' ? before : null,
        },
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

const exact = (value, keys) => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

function validFocusPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (value.status === 'ambiguous') {
    return exact(value, ['schemaVersion', 'status', 'count'])
      && Number.isSafeInteger(value.count) && value.count > 1;
  }
  if (['wrong-editor', 'invalid-runtime', 'not-found', 'wrong-type', 'refused'].includes(value.status)) {
    return Object.keys(value).length === 2;
  }
  if (value.status !== 'ok') return false;
  if (!exact(value, ['schemaVersion', 'status', 'data'])) return false;
  const data = value.data;
  if (!exact(data, ['focusedId', 'name', 'label', 'previousId'])) return false;
  if (typeof data.focusedId !== 'string' || !NODE_REFERENCE_PATTERN.test(data.focusedId)) return false;
  if (typeof data.name !== 'string' || data.name.length > 4096) return false;
  if (data.label !== null && (typeof data.label !== 'string' || data.label.length > 4096)) return false;
  return data.previousId === null
    || (typeof data.previousId === 'string' && NODE_REFERENCE_PATTERN.test(data.previousId));
}

function validViewPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (['wrong-editor', 'invalid-runtime', 'refused'].includes(value.status)) {
    return Object.keys(value).length === 2;
  }
  if (value.status !== 'ok') return false;
  if (!exact(value, ['schemaVersion', 'status', 'data'])) return false;
  if (!exact(value.data, ['mode', 'previousMode'])) return false;
  if (!MODES.has(value.data.mode)) return false;
  return value.data.previousMode === null || MODES.has(value.data.previousMode);
}

async function evaluatePayload(adapters, code, label, validate) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError(`${label} requires a Figma evaluate adapter.`);
  }
  const serialized = await adapters.evaluate(code);
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_VIEWPORT_RESULT_CODE_UNITS) {
    throw new Error(`${label} returned an invalid bounded result.`);
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error(`${label} returned invalid JSON.`); }
  if (!validate(payload)) throw new Error(`${label} returned an invalid bounded result.`);
  return payload;
}

async function executeFocus(request, adapters) {
  const payload = await evaluatePayload(
    adapters, slidesFocusCode(request), 'Slides Focus', validFocusPayload,
  );
  if (payload.status === 'wrong-editor') throw new Error('Slides focus requires a Figma Slides deck.');
  if (payload.status === 'not-found') throw new Error('Slide not found.');
  if (payload.status === 'wrong-type') throw new Error('The named node is not a SLIDE.');
  if (payload.status === 'ambiguous') {
    throw new Error(`Ambiguous slide reference: ${payload.count} slides match.`);
  }
  if (payload.status === 'refused') {
    throw new Error('Figma did not accept the focus change; the deck kept its previous focus.');
  }
  if (payload.status !== 'ok') throw new Error('Slides focus could not read a bounded native deck.');
  const { focusedId, label, name, previousId } = payload.data;
  return {
    stdout: `Focused ${label || name} (${focusedId})${previousId ? `; was ${previousId}` : ''}`,
    stderr: '',
    code: 0,
    result: payload.data,
  };
}

async function executeView(request, adapters) {
  const payload = await evaluatePayload(
    adapters, slidesViewCode(request), 'Slides View', validViewPayload,
  );
  if (payload.status === 'wrong-editor') throw new Error('Slides view requires a Figma Slides deck.');
  if (payload.status === 'refused') {
    throw new Error('Figma did not accept the view change; the deck kept its previous view.');
  }
  if (payload.status !== 'ok') throw new Error('Slides view could not read the native viewport.');
  const { mode, previousMode } = payload.data;
  return {
    stdout: `Slides view: ${mode}${previousMode && previousMode !== mode ? ` (was ${previousMode})` : ''}`,
    stderr: '',
    code: 0,
    result: payload.data,
  };
}

export function slidesFocusPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Focus routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === FOCUS_APPLICATION_ID
    ? 'command-application' : 'not-slides-focus';
}

export function slidesViewPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides View routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === VIEW_APPLICATION_ID
    ? 'command-application' : 'not-slides-view';
}

export function executeSlidesFocusPlan(plan, adapters = {}) {
  if (slidesFocusPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Focus.');
  }
  return executeFocus(parseSlidesReferenceRequest(plan.argv), adapters);
}

export function executeSlidesViewPlan(plan, adapters = {}) {
  if (slidesViewPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides View.');
  }
  return executeView(parseSlidesViewRequest(plan.argv), adapters);
}

/** Direct entries for callers holding canonical argv. */
export function executeSlidesFocus(argv, adapters = {}) {
  return executeFocus(parseSlidesReferenceRequest(argv), adapters);
}

export function executeSlidesView(argv, adapters = {}) {
  return executeView(parseSlidesViewRequest(argv), adapters);
}
