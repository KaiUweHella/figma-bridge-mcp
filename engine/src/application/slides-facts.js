// Host-side validator for the shared Slides deck fact shape.
//
// The eval fragment in slides-snippets.js produces these records inside the
// plugin; nothing that crosses back is trusted until it matches here. Kept in
// one module so a second deck-wide reader cannot quietly accept a wider shape
// than the first one does.

import {
  MAX_DECK_NAME_CODE_UNITS,
  MAX_DECK_TRANSITION_SECONDS,
  TRANSITION_CURVES,
  TRANSITION_STYLES,
  TRANSITION_TIMINGS,
} from '../lib/slides-snippets.js';

const STYLES = new Set(TRANSITION_STYLES);
const CURVES = new Set(TRANSITION_CURVES);
const TIMINGS = new Set(TRANSITION_TIMINGS);
const NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const FACT_KEYS = ['id', 'name', 'label', 'row', 'col', 'skipped', 'transition', 'childCount'];

const exact = (value, keys) => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const seconds = (value) => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= MAX_DECK_TRANSITION_SECONDS;

const text = (value) => typeof value === 'string' && value.length <= MAX_DECK_NAME_CODE_UNITS;

/** True only for a complete, in-range transition record. */
export function validDeckTransition(value) {
  if (!exact(value, ['style', 'duration', 'curve', 'timing'])) return false;
  if (!STYLES.has(value.style) || !CURVES.has(value.curve) || !seconds(value.duration)) return false;
  if (!value.timing || !TIMINGS.has(value.timing.type)) return false;
  return value.timing.type === 'AFTER_DELAY'
    ? exact(value.timing, ['type', 'delay']) && seconds(value.timing.delay)
    : exact(value.timing, ['type']);
}

/** True only for one complete per-slide fact record. */
export function validDeckFact(value) {
  if (!exact(value, FACT_KEYS)) return false;
  if (typeof value.id !== 'string' || !NODE_ID.test(value.id)) return false;
  if (!text(value.name)) return false;
  if (value.label !== null && !text(value.label)) return false;
  if (value.label === '') return false;
  for (const key of ['row', 'col']) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  }
  if (typeof value.skipped !== 'boolean') return false;
  if (!Number.isSafeInteger(value.childCount) || value.childCount < 0) return false;
  return validDeckTransition(value.transition);
}

export { FACT_KEYS as DECK_FACT_KEYS };
