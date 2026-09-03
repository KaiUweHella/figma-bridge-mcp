// Bounded, read-only Figma Slides deck lint.
//
// Four structural findings over one grid walk. Each is a fact about the deck,
// not a matter of taste: a name collision makes a slide unaddressable by
// `name:`/`label:`, authored content on a skipped slide never plays, a missing
// transition breaks an otherwise consistent deck, and an empty slide is
// unfinished work. The findings shape follows `analyze lint` so a caller that
// can render one can render the other.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_DECK_SLIDES, slideDeckFactsFragment } from '../lib/slides-snippets.js';
import { parseSlidesLintRequest } from './slides-lint-request.js';

const APPLICATION_ID = 'slides.lint';
export const MAX_SLIDES_LINT_RESULT_CODE_UNITS = 2_000_000;
export const SLIDES_LINT_KINDS = Object.freeze([
  'duplicate-name', 'skipped-placement', 'missing-transition', 'empty-slide',
  'unlisted-slide',
]);

const LINT_META = Object.freeze({
  'duplicate-name': 'slides sharing a name or Bridge label',
  'skipped-placement': 'skipped slides that still carry content',
  'missing-transition': 'slides without a transition',
  'empty-slide': 'slides with no content',
  'unlisted-slide': 'slides the canvas grid does not list',
});

export function slidesLintCode(request) {
  const kinds = JSON.stringify(request.kinds);
  return `(async () => {
    const schemaVersion = 1;
    const wanted = new Set(${kinds});
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_LINT_RESULT_CODE_UNITS}) {
        throw new Error('Slides Lint result exceeded its bounded response limit.');
      }
      return serialized;
    };
    ${slideDeckFactsFragment()}
    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      const deck = __deckRead();
      const facts = [];
      for (const row of deck.rows) for (const slide of row) facts.push(__deckFacts(slide));
      const unlisted = new Set(deck.unlisted);
      // Slides the grid omits still exist and still present. They have no
      // coordinate, so they are appended rather than placed.
      for (const slide of deck.slides) {
        if (unlisted.has(slide.id)) facts.push(__deckFacts(slide));
      }

      const issues = [];
      const add = (kind, fact, detail) => {
        if (!wanted.has(kind)) return;
        issues.push({
          kind, id: fact.id, name: fact.name, label: fact.label,
          row: fact.row, col: fact.col, detail,
        });
      };

      // A name or label shared by two slides makes both unaddressable by that
      // reference: the Bridge refuses an ambiguous name:/label: lookup.
      const byName = new Map();
      for (const fact of facts) {
        for (const value of [fact.name, fact.label]) {
          if (typeof value !== 'string' || !value) continue;
          if (!byName.has(value)) byName.set(value, []);
          byName.get(value).push(fact);
        }
      }
      for (const [value, group] of byName) {
        if (group.length < 2) continue;
        for (const fact of group) {
          add('duplicate-name', fact,
            'shares the identifier ' + JSON.stringify(value) + ' with ' + (group.length - 1)
            + ' other slide(s), so name:/label: cannot address it');
        }
      }

      for (let index = 0; index < facts.length; index++) {
        const fact = facts[index];
        if (fact.skipped && fact.childCount > 0) {
          add('skipped-placement', fact,
            'is skipped in playback but carries ' + fact.childCount
            + ' child(ren), so that content never appears');
        }
        // The deck's first slide has nothing to transition from, so NONE there
        // is the normal authored state rather than an omission. The exemption
        // is positional, so it never covers a slide without a position.
        if (fact.transition.style === 'NONE' && (index > 0 || fact.row === null)) {
          add('missing-transition', fact,
            'has no transition while the deck uses them elsewhere');
        }
        if (fact.childCount === 0) {
          add('empty-slide', fact, 'has no content at all');
        }
        if (unlisted.has(fact.id)) {
          add('unlisted-slide', fact,
            'exists on the page but figma.getCanvasGrid() does not list it, so every'
            + ' grid-based command is blind to it and slides delete cannot remove it');
        }
      }

      const counts = {};
      for (const issue of issues) counts[issue.kind] = (counts[issue.kind] || 0) + 1;
      return result({
        schemaVersion,
        status: 'ok',
        data: {
          source: 'deck',
          slidesWalked: facts.length,
          total: issues.length,
          counts,
          issues,
        },
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

const KINDS = new Set(SLIDES_LINT_KINDS);
const NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function validIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['kind', 'id', 'name', 'label', 'row', 'col', 'detail'];
  if (Object.keys(value).length !== keys.length) return false;
  if (!keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (!KINDS.has(value.kind)) return false;
  if (typeof value.id !== 'string' || !NODE_ID.test(value.id)) return false;
  if (typeof value.name !== 'string' || value.name.length > 4096) return false;
  if (value.label !== null && (typeof value.label !== 'string' || value.label.length > 4096)) return false;
  for (const key of ['row', 'col']) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  }
  return typeof value.detail === 'string' && value.detail.length > 0 && value.detail.length <= 4096;
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
  if (Object.keys(data).length !== 5 || data.source !== 'deck') return false;
  if (!Number.isSafeInteger(data.slidesWalked) || data.slidesWalked < 0
    || data.slidesWalked > MAX_DECK_SLIDES) return false;
  if (!Array.isArray(data.issues) || !data.issues.every(validIssue)) return false;
  if (data.total !== data.issues.length) return false;
  if (!data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) return false;
  // The header must reconcile with the body, exactly as `analyze lint` requires.
  const counted = {};
  for (const issue of data.issues) counted[issue.kind] = (counted[issue.kind] || 0) + 1;
  const reported = Object.keys(data.counts);
  if (reported.length !== Object.keys(counted).length) return false;
  return reported.every((kind) => KINDS.has(kind) && data.counts[kind] === counted[kind]);
}

function formatLint(data, request) {
  if (!data.total) {
    return `Slides lint: no findings across ${data.slidesWalked} slide(s).`;
  }
  const lines = [`Slides lint: ${data.total} finding(s) across ${data.slidesWalked} slide(s).`];
  for (const kind of SLIDES_LINT_KINDS) {
    const group = data.issues.filter((issue) => issue.kind === kind);
    if (!group.length) continue;
    lines.push('', `${kind} — ${LINT_META[kind]} (${group.length})`);
    for (const issue of group.slice(0, request.limit)) {
      const identity = issue.label ? `${issue.label} (${issue.id})` : `${issue.name} (${issue.id})`;
      lines.push(`  [${issue.row},${issue.col}] ${identity}: ${issue.detail}`);
    }
    if (group.length > request.limit) {
      lines.push(`  … +${group.length - request.limit} more (raise --limit)`);
    }
  }
  return lines.join('\n');
}

async function executeParsed(request, adapters) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Lint requires a Figma evaluate adapter.');
  }
  const serialized = await adapters.evaluate(slidesLintCode(request));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_LINT_RESULT_CODE_UNITS) {
    throw new Error('Slides Lint returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Slides Lint returned invalid JSON.'); }
  if (!validPayload(payload)) {
    throw new Error('Slides Lint returned an invalid bounded result.');
  }
  if (payload.status === 'wrong-editor') {
    throw new Error('Slides lint requires a Figma Slides deck.');
  }
  if (payload.status !== 'ok') {
    throw new Error('Slides lint could not read a bounded native deck.');
  }
  return {
    stdout: formatLint(payload.data, request),
    stderr: '',
    // Findings are a reportable outcome, not a transport failure; only
    // --fail-on-issues turns them into a non-zero exit.
    code: request.failOnIssues && payload.data.total ? 1 : 0,
    result: payload.data,
  };
}

/** Direct entry for callers that already hold canonical argv. */
export function executeSlidesLint(argv, adapters = {}) {
  return executeParsed(parseSlidesLintRequest(argv), adapters);
}

export function slidesLintPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Lint routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-lint';
}

export function executeSlidesLintPlan(plan, adapters = {}) {
  if (slidesLintPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Lint.');
  }
  return executeParsed(parseSlidesLintRequest(plan.argv), adapters);
}
