// Bounded, read-only Figma Slides deck manifest.
//
// One compact projection of a whole deck, shaped for review and version
// control: the same per-slide facts every other Slides reader reports, in grid
// order, with nothing that changes between two identical reads except the
// document itself. It deliberately has no output-path option — the manifest is
// returned as the command result, so persisting it stays the caller's decision
// and this Application keeps `effects.workspace: 'none'`.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  INTERACTIVE_SLIDE_ELEMENT_TYPES,
  MAX_DECK_SLIDES,
  MAX_INTERACTIVE_ELEMENTS_PER_SLIDE,
  slideDeckFactsFragment,
  slideInteractiveElementsFragment,
} from '../lib/slides-snippets.js';
import { parseSlidesReferenceRequest } from './slides-reference-request.js';
import { validDeckFact } from './slides-facts.js';

const APPLICATION_ID = 'slides.manifest';
export const MAX_SLIDES_MANIFEST_RESULT_CODE_UNITS = 2_000_000;
export const SLIDES_MANIFEST_SCHEMA = 'figma-bridge/slides-deck-manifest/v1';

export function slidesManifestCode() {
  return `(async () => {
    const schemaVersion = 1;
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_MANIFEST_RESULT_CODE_UNITS}) {
        throw new Error('Slides Manifest result exceeded its bounded response limit.');
      }
      return serialized;
    };
    ${slideDeckFactsFragment()}
    ${slideInteractiveElementsFragment()}
    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      const deck = __deckRead();
      const project = (slide) => {
        const facts = __deckFacts(slide);
        // Interactive elements are reportable but not authorable: the typings
        // declare no create factory for them, so a manifest is the only place
        // a reviewer can see that a slide carries a poll or a facepile.
        const interactive = __deckInteractive(slide);
        return {
          ...facts,
          interactive: interactive.elements,
          interactiveTruncated: interactive.truncated,
        };
      };
      const rows = deck.rows.map((row) => row.map(project));
      // A slide the canvas grid omits still exists and still presents. It has
      // no coordinate, so it cannot sit in a row, but leaving it out would
      // make the manifest disagree with the file it describes.
      const unlistedIds = new Set(deck.unlisted);
      const unlisted = deck.slides.filter((slide) => unlistedIds.has(slide.id)).map(project);
      return result({
        schemaVersion,
        status: 'ok',
        data: {
          schema: ${JSON.stringify(SLIDES_MANIFEST_SCHEMA)},
          slideCount: deck.slides.length,
          focusedId: deck.focusedId,
          rows,
          unlisted,
        },
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

const INTERACTIVE_TYPES = new Set([...INTERACTIVE_SLIDE_ELEMENT_TYPES, 'UNKNOWN']);
const INTERACTIVE_NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const NODE_ID = INTERACTIVE_NODE_ID;

function validInteractiveElement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 3) return false;
  if (typeof value.id !== 'string' || !INTERACTIVE_NODE_ID.test(value.id)) return false;
  if (!INTERACTIVE_TYPES.has(value.type)) return false;
  return typeof value.name === 'string' && value.name.length <= 4096;
}

/** One manifest row: the shared deck fact plus its interactive inventory. */
function validManifestFact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { interactive, interactiveTruncated, ...fact } = value;
  if (!validDeckFact(fact)) return false;
  if (typeof interactiveTruncated !== 'boolean') return false;
  if (!Array.isArray(interactive)
    || interactive.length > MAX_INTERACTIVE_ELEMENTS_PER_SLIDE
    || !interactive.every(validInteractiveElement)) return false;
  return true;
}

function validPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (value.status === 'wrong-editor' || value.status === 'invalid-runtime') {
    return Object.keys(value).length === 2;
  }
  if (value.status !== 'ok' || Object.keys(value).length !== 3) return false;
  const data = value.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (Object.keys(data).length !== 5) return false;
  if (data.schema !== SLIDES_MANIFEST_SCHEMA) return false;
  if (!Number.isSafeInteger(data.slideCount) || data.slideCount < 0
    || data.slideCount > MAX_DECK_SLIDES) return false;
  if (data.focusedId !== null && typeof data.focusedId !== 'string') return false;
  if (!Array.isArray(data.rows) || !Array.isArray(data.unlisted)) return false;
  let counted = 0;
  const seen = new Set();
  for (const row of data.rows) {
    if (!Array.isArray(row)) return false;
    for (const fact of row) {
      if (!validManifestFact(fact)) return false;
      if (seen.has(fact.id)) return false;
      seen.add(fact.id);
      counted++;
    }
  }
  for (const fact of data.unlisted) {
    if (!validManifestFact(fact)) return false;
    if (seen.has(fact.id)) return false;
    // A slide outside the grid has no coordinate by definition.
    if (fact.row !== null || fact.col !== null) return false;
    seen.add(fact.id);
    counted++;
  }
  // The count is a claim about the same walk that produced the rows; a
  // manifest whose header disagrees with its body is not reviewable.
  if (counted !== data.slideCount) return false;
  // The focused slide need not appear in the walk: Figma's canvas grid is
  // eventually consistent and can omit a slide it has already focused, which a
  // timed-out create reproduced. Requiring membership turned a readable deck
  // into an error, so the id is reported and its presence is a separate fact.
  if (data.focusedId !== null && !NODE_ID.test(data.focusedId)) return false;
  return true;
}

function formatManifest(data) {
  const listed = new Set(data.rows.flat().map((fact) => fact.id));
  const focusNote = data.focusedId
    ? `, focused ${data.focusedId}${listed.has(data.focusedId) ? '' : ' (not yet listed in the grid)'}`
    : '';
  const lines = [
    `${data.schema}`,
    `${data.slideCount} slide(s)${focusNote}`,
    '',
  ];
  const tail = data.unlisted.length
    ? ['', `${data.unlisted.length} slide(s) exist on the page but are not listed in the canvas grid:`]
    : [];
  data.rows.forEach((row, rowIndex) => {
    if (!row.length) {
      lines.push(`row ${rowIndex}: (empty)`);
      return;
    }
    for (const fact of row) {
      const interactive = fact.interactive.length
        ? `interactive: ${fact.interactive.map((element) => element.type).join(', ')}${fact.interactiveTruncated ? ', …' : ''}`
        : null;
      const marks = [
        fact.skipped ? 'skipped' : null,
        fact.childCount === 0 ? 'empty' : `${fact.childCount} child(ren)`,
        fact.transition.style === 'NONE'
          ? 'no transition'
          : `${fact.transition.style} ${fact.transition.duration}s ${fact.transition.curve}`,
        interactive,
      ].filter(Boolean);
      lines.push(`[${fact.row},${fact.col}] ${fact.id} ${JSON.stringify(fact.label ?? fact.name)} — ${marks.join(' · ')}`);
    }
  });
  for (const fact of data.unlisted) {
    tail.push(`  [--,--] ${fact.id} ${JSON.stringify(fact.label ?? fact.name)} — ${fact.childCount === 0 ? 'empty' : `${fact.childCount} child(ren)`}`);
  }
  return lines.concat(tail).join('\n');
}

async function executeParsed(adapters) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Manifest requires a Figma evaluate adapter.');
  }
  const serialized = await adapters.evaluate(slidesManifestCode());
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_MANIFEST_RESULT_CODE_UNITS) {
    throw new Error('Slides Manifest returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Slides Manifest returned invalid JSON.'); }
  if (!validPayload(payload)) {
    throw new Error('Slides Manifest returned an invalid bounded result.');
  }
  if (payload.status === 'wrong-editor') {
    throw new Error('Slides manifest requires a Figma Slides deck.');
  }
  if (payload.status !== 'ok') {
    throw new Error('Slides manifest could not read a bounded native deck.');
  }
  return {
    stdout: formatManifest(payload.data),
    stderr: '',
    code: 0,
    result: payload.data,
  };
}

export function executeSlidesManifest(adapters = {}) {
  return executeParsed(adapters);
}

export function slidesManifestArgvFromRequest() {
  return ['slides', 'manifest'];
}

export function slidesManifestPlanningArgvFromRequest() {
  return ['slides', 'manifest'];
}

export function slidesManifestPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Manifest routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-manifest';
}

export function executeSlidesManifestPlan(plan, adapters = {}) {
  if (slidesManifestPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Manifest.');
  }
  parseSlidesReferenceRequest(plan.argv);
  return executeParsed(adapters);
}
