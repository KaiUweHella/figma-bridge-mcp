// Insert one local media file into a Figma Slides slide.
//
// The Plugin API typings mark `createGif` as FigJam-only, but a live Slides
// runtime answers `typeof figma.createGif === 'function'` and fails a bad call
// with `Invalid SHA1 hash` -- an argument complaint, not an editor refusal. The
// note documents intent, it does not gate the runtime, so an animated GIF is
// reachable here. `createVideoAsync` likewise only refuses on file type.
//
// Bytes travel inside the eval payload, base64-encoded: the asset stream is an
// export path only, so there is no inbound streaming. Base64 inflates a file by
// 4/3 against a 5 MB protocol ceiling, which is why the ceiling is ~3.5 MB --
// the same `IMAGE_HARD_LIMIT` every other inbound image command derives from
// the transport.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import { SLIDE_LABEL_KEY, slidePageSlidesFragment } from '../lib/slides-snippets.js';
import {
  SLIDES_MEDIA_HARD_LIMIT,
  parseSlidesMediaRequest,
} from './slides-media-request.js';

const APPLICATION_ID = 'slides.media';
export const MAX_SLIDES_MEDIA_RESULT_CODE_UNITS = 64_000;
const PREPARED = new WeakSet();

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function slidesMediaPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Media routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-media';
}

/** Authorize and read the file before any Figma call is generated. */
export function prepareSlidesMediaPlan(plan, adapters = {}) {
  if (slidesMediaPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Media.');
  }
  if (!adapters.workspaceIO) {
    throw new TypeError('Slides Media requires an authorized WorkspaceIO capability.');
  }
  const request = parseSlidesMediaRequest(plan.argv);
  const accepted = adapters.workspaceIO.authorizePath(request.file, {
    access: 'read', role: 'slides-media', kind: 'file',
  });
  if (accepted.metadata.size > SLIDES_MEDIA_HARD_LIMIT) {
    throw new Error(
      `Workspace slides-media rejected: file is ${accepted.metadata.size} bytes, over the `
      + `${SLIDES_MEDIA_HARD_LIMIT} byte ceiling. Inbound media rides in the eval payload `
      + '(there is no inbound asset stream) and base64 inflates it by 4/3 against a 5 MB '
      + 'protocol limit. Compress it, or shorten the clip.',
    );
  }
  const bytes = adapters.workspaceIO.read(accepted.canonical, {
    role: 'slides-media', maxBytes: SLIDES_MEDIA_HARD_LIMIT,
  });
  const prepared = Object.freeze({
    request,
    sourceBytes: bytes.length,
    sourceBase64: bytes.toString('base64'),
  });
  PREPARED.add(prepared);
  return prepared;
}

export function slidesMediaCode(prepared) {
  if (!PREPARED.has(prepared)) {
    throw new TypeError('Slides Media requires authentic prepared input.');
  }
  const { request, sourceBase64 } = prepared;
  const reference = { kind: request.reference.kind, value: request.reference.value };
  return `(async () => {
    const schemaVersion = 1;
    const reference = ${jsValue(reference)};
    const kind = ${jsValue(request.kind)};
    const fit = ${jsValue(request.fit)};
    const wanted = ${jsValue(request.name)};
    const labelKey = ${jsValue(SLIDE_LABEL_KEY)};
    const source = ${jsValue(sourceBase64)};
    const idPattern = ${NODE_REFERENCE_PATTERN};
    const result = (payload) => JSON.stringify(payload);
    const labelOf = (slide) => {
      try { return slide.getPluginData(labelKey) || ''; } catch { return ''; }
    };
    let created = null;
    try {
      if (figma.editorType !== 'slides') {
        return result({ schemaVersion, status: 'wrong-editor' });
      }
      for (const name of ['getCanvasGrid', 'getNodeByIdAsync', 'base64Decode', 'createImage', 'createRectangle']) {
        if (typeof figma[name] !== 'function') {
          return result({ schemaVersion, status: 'invalid-runtime' });
        }
      }
      if (kind === 'gif' && typeof figma.createGif !== 'function') {
        return result({ schemaVersion, status: 'unsupported', detail: 'createGif' });
      }
      if (kind === 'video' && typeof figma.createVideoAsync !== 'function') {
        return result({ schemaVersion, status: 'unsupported', detail: 'createVideoAsync' });
      }

      ${slidePageSlidesFragment()}
      const grid = figma.getCanvasGrid();
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

      let slide = null;
      if (reference.kind === 'node' || reference.kind === 'query') {
        let byId = null;
        try { byId = await figma.getNodeByIdAsync(reference.value); } catch { byId = null; }
        if (byId && byId.type === 'SLIDE') slide = byId;
        else if (reference.kind === 'node') {
          return result({ schemaVersion, status: byId ? 'wrong-type' : 'not-found' });
        }
      }
      if (!slide) {
        const matches = reference.kind === 'name'
          ? slides.filter((entry) => entry.name === reference.value)
          : reference.kind === 'label'
            ? slides.filter((entry) => labelOf(entry) === reference.value)
            : slides.filter((entry) => entry.name === reference.value
              || labelOf(entry) === reference.value);
        if (matches.length > 1) {
          return result({ schemaVersion, status: 'ambiguous', count: matches.length });
        }
        if (matches.length === 1) slide = matches[0];
      }
      if (!slide && reference.kind === 'query') {
        const lower = reference.value.toLowerCase();
        const fuzzy = slides.filter((entry) => entry.name.toLowerCase().includes(lower)
          || labelOf(entry).toLowerCase().includes(lower));
        if (fuzzy.length > 1) {
          return result({ schemaVersion, status: 'ambiguous', count: fuzzy.length });
        }
        if (fuzzy.length === 1) slide = fuzzy[0];
      }
      if (!slide) return result({ schemaVersion, status: 'not-found' });

      const slideWidth = Number(slide.width) || 1920;
      const slideHeight = Number(slide.height) || 1080;
      const bytes = figma.base64Decode(source);

      // Fit the media inside the slide without upscaling it.
      const boxed = (width, height) => {
        if (!(width > 0) || !(height > 0)) return [slideWidth / 2, slideHeight / 2];
        const scale = Math.min(1, slideWidth / width, slideHeight / height);
        return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
      };

      let mediaKind = kind;
      if (kind === 'video') {
        const video = await figma.createVideoAsync(bytes);
        created = figma.createRectangle();
        const [width, height] = [slideWidth, slideHeight];
        created.resize(width, height);
        created.fills = [{ type: 'VIDEO', scaleMode: fit, videoHash: video.hash }];
      } else {
        const image = figma.createImage(bytes);
        // The same Image supplies the hash and the pixel size, so both a GIF
        // and a still can be fitted to the slide instead of arriving at
        // whatever default Figma picks (a MEDIA node comes in at 100x100).
        let natural = null;
        try { natural = await image.getSizeAsync(); } catch { natural = null; }
        const [width, height] = boxed(natural && natural.width, natural && natural.height);
        if (kind === 'gif') {
          created = figma.createGif(image.hash);
          mediaKind = 'gif';
          if (typeof created.resize === 'function') created.resize(width, height);
        } else {
          created = figma.createRectangle();
          created.resize(width, height);
          created.fills = [{ type: 'IMAGE', scaleMode: fit, imageHash: image.hash }];
        }
      }
      if (!created) return result({ schemaVersion, status: 'invalid-runtime' });
      if (wanted) created.name = wanted;
      slide.appendChild(created);
      if (created.parent !== slide) throw new Error('the slide did not accept the media node');
      created.x = 0;
      created.y = 0;

      // Readback: the node has to exist, belong to the slide, and be the kind
      // the file asked for. Anything else is rolled back below.
      const back = await figma.getNodeByIdAsync(created.id);
      if (!back || back.parent !== slide) throw new Error('the media node was not found on the slide');
      if (!idPattern.test(String(created.id))) throw new Error('the media node has an unusable id');
      return result({
        schemaVersion,
        status: 'ok',
        data: {
          id: created.id,
          slideId: slide.id,
          type: back.type,
          kind: mediaKind,
          name: typeof back.name === 'string' ? back.name.slice(0, 4096) : '',
          width: Math.round(Number(back.width) || 0),
          height: Math.round(Number(back.height) || 0),
        },
      });
    } catch (error) {
      // A half-inserted media node is worse than none: remove what was made.
      let residue = false;
      if (created) {
        try { created.remove(); } catch { residue = true; }
      }
      // Not every Figma rejection is an Error with a message -- a bare string
      // or a plain object reaches here too, and "unknown" hides exactly the
      // reason a caller needs (a plan restriction, an unsupported codec).
      let detail = '';
      try {
        detail = (error && typeof error.message === 'string' && error.message)
          || (typeof error === 'string' && error)
          || (error && typeof error.toString === 'function' && error.toString())
          || '';
        if (!detail || detail === '[object Object]') detail = JSON.stringify(error) || '';
      } catch { detail = ''; }
      return JSON.stringify({
        schemaVersion,
        status: 'failed',
        outcome: residue ? 'partial-residue' : 'rolled-back',
        detail: (detail || 'the Figma runtime rejected the media without a message').slice(0, 200),
      });
    }
  })()`;
}

const exact = (value, keys) => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

function validPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (['wrong-editor', 'invalid-runtime', 'not-found', 'wrong-type'].includes(value.status)) {
    return Object.keys(value).length === 2;
  }
  if (value.status === 'ambiguous') {
    return exact(value, ['schemaVersion', 'status', 'count'])
      && Number.isSafeInteger(value.count) && value.count > 1;
  }
  if (value.status === 'unsupported') {
    return exact(value, ['schemaVersion', 'status', 'detail'])
      && ['createGif', 'createVideoAsync'].includes(value.detail);
  }
  if (value.status === 'failed') {
    return exact(value, ['schemaVersion', 'status', 'outcome', 'detail'])
      && ['rolled-back', 'partial-residue'].includes(value.outcome)
      && typeof value.detail === 'string' && value.detail.length <= 4096;
  }
  if (value.status !== 'ok') return false;
  if (!exact(value, ['schemaVersion', 'status', 'data'])) return false;
  const data = value.data;
  if (!exact(data, ['id', 'slideId', 'type', 'kind', 'name', 'width', 'height'])) return false;
  for (const key of ['id', 'slideId']) {
    if (typeof data[key] !== 'string' || !NODE_REFERENCE_PATTERN.test(data[key])) return false;
  }
  if (typeof data.type !== 'string' || data.type.length > 64) return false;
  if (!['image', 'gif', 'video'].includes(data.kind)) return false;
  if (typeof data.name !== 'string' || data.name.length > 4096) return false;
  return ['width', 'height'].every((key) => Number.isSafeInteger(data[key]) && data[key] >= 0);
}

function mutationError(payload) {
  return Object.assign(new Error(`Slides media failed: ${payload.detail}`), {
    kind: 'mutation',
    phase: 'plugin-execution',
    outcome: payload.outcome,
    dispatchState: 'failed',
    mutationOutcome: payload.outcome,
    mutationReport: { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.outcome === 'rolled-back' ? 1 : 0, residueCount: payload.outcome === 'rolled-back' ? 0 : 1 },
  });
}

export async function executeSlidesMediaPrepared(prepared, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Media requires a Figma evaluate adapter.');
  }
  const serialized = await adapters.evaluate(slidesMediaCode(prepared));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_MEDIA_RESULT_CODE_UNITS) {
    throw new Error('Slides Media returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Slides Media returned invalid JSON.'); }
  if (!validPayload(payload)) throw new Error('Slides Media returned an invalid bounded result.');
  if (payload.status === 'wrong-editor') throw new Error('Slides media requires a Figma Slides deck.');
  if (payload.status === 'not-found') throw new Error('Slide not found.');
  if (payload.status === 'wrong-type') throw new Error('The named node is not a SLIDE.');
  if (payload.status === 'ambiguous') {
    throw new Error(`Ambiguous slide reference: ${payload.count} slides match.`);
  }
  if (payload.status === 'unsupported') {
    throw new Error(`This Figma runtime does not expose ${payload.detail}; the media kind is unavailable here.`);
  }
  if (payload.status === 'failed') throw mutationError(payload);
  if (payload.status !== 'ok') throw new Error('Slides media could not read a bounded native deck.');
  const { id, slideId, kind, width, height, name } = payload.data;
  return {
    stdout: `Inserted ${kind} ${id} (${width}x${height})${name ? ` "${name}"` : ''} into slide ${slideId}`,
    stderr: '',
    code: 0,
    result: payload.data,
  };
}

export function executeSlidesMediaPlan(plan, adapters = {}) {
  const prepared = prepareSlidesMediaPlan(plan, adapters);
  return executeSlidesMediaPrepared(prepared, adapters);
}
