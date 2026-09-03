// Slides media insertion: file authorization before any Figma call, and a
// created node removed again if the insert cannot be verified.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { SLIDE_LABEL_KEY } from '../src/lib/slides-snippets.js';
import {
  executeSlidesMediaPrepared,
  prepareSlidesMediaPlan,
  slidesMediaCode,
} from '../src/application/slides-media-command.js';
import {
  SLIDES_MEDIA_HARD_LIMIT,
  parseSlidesMediaRequest,
  slidesMediaKind,
} from '../src/application/slides-media-request.js';

// The real Command Plan, so the Application is exercised through the same
// gate the CLI and the MCP server go through.
const plan = (argv, io) => planFigmaCommand(argv, {
  adapter: 'cli', fileKey: null, workspaceDir: io.roots[0], workspaceIO: io,
});

function workspace({ size = 1024, bytes = Buffer.from([1, 2, 3, 4]) } = {}) {
  return {
    roots: ['/workspace'],
    authorizePath(file) {
      return { canonical: file, metadata: { size } };
    },
    read() { return bytes; },
  };
}

function runtime({
  editorType = 'slides',
  hasCreateGif = true,
  hasCreateVideo = true,
  appendRefuses = false,
  gifThrows = null,
} = {}) {
  let nextId = 500;
  const nodes = new Map();
  const slide = {
    id: '1:1',
    name: '1',
    type: 'SLIDE',
    width: 1920,
    height: 1080,
    children: [],
    getPluginData(key) { return key === SLIDE_LABEL_KEY ? 'Cover' : ''; },
    appendChild(child) {
      if (appendRefuses) return;
      this.children.push(child);
      child.parent = this;
    },
  };
  nodes.set(slide.id, slide);

  const makeNode = (type) => {
    const node = {
      id: `1:${nextId++}`,
      name: type,
      type,
      width: 0,
      height: 0,
      fills: [],
      parent: null,
      resize(width, height) { this.width = width; this.height = height; },
      remove() { nodes.delete(this.id); if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    };
    nodes.set(node.id, node);
    return node;
  };

  const figma = {
    editorType,
    getCanvasGrid() { return [[slide]]; },
    async getNodeByIdAsync(id) { return nodes.get(id) || null; },
    base64Decode(value) { return Uint8Array.from(Buffer.from(value, 'base64')); },
    createImage() { return { hash: 'abc', async getSizeAsync() { return { width: 3840, height: 2160 }; } }; },
    createRectangle() { return makeNode('RECTANGLE'); },
  };
  if (hasCreateGif) {
    figma.createGif = () => {
      if (gifThrows) throw new Error(gifThrows);
      return makeNode('MEDIA');
    };
  }
  if (hasCreateVideo) {
    figma.createVideoAsync = async () => ({ hash: 'vid' });
  }
  return { figma, slide, nodes, evaluate: (code) => new Function('figma', `return ${code}`)(figma) };
}

const run = (live, argv, io = workspace()) => {
  const prepared = prepareSlidesMediaPlan(plan(argv, io), { workspaceIO: io });
  return executeSlidesMediaPrepared(prepared, { evaluate: live.evaluate });
};

describe('Slides media', () => {
  it('routes each extension to the primitive that can carry it', () => {
    assert.equal(slidesMediaKind('/a/loop.gif'), 'gif');
    assert.equal(slidesMediaKind('/a/clip.MP4'), 'video');
    assert.equal(slidesMediaKind('/a/shot.png'), 'image');
    assert.equal(slidesMediaKind('/a/doc.pdf'), null);
  });

  it('inserts an animated GIF as a media node, not a static fill', async () => {
    const live = runtime();
    const result = await run(live, ['slides', 'media', 'label:Cover', '/w/loop.gif', '--name=Loop']);

    assert.equal(result.result.kind, 'gif');
    assert.equal(result.result.type, 'MEDIA', 'createGif produces a MEDIA node that plays');
    assert.equal(result.result.slideId, '1:1');
    assert.equal(live.slide.children.length, 1);
    assert.match(result.stdout, /Inserted gif/);
  });

  it('fits a static image inside the slide without upscaling it', async () => {
    const live = runtime();
    const result = await run(live, ['slides', 'media', 'label:Cover', '/w/shot.png']);
    // The fake image is 3840x2160 on a 1920x1080 slide: scaled to fit exactly.
    assert.deepEqual([result.result.width, result.result.height], [1920, 1080]);
    assert.equal(result.result.kind, 'image');
    assert.equal(result.result.type, 'RECTANGLE');
  });

  it('inserts a video as a VIDEO paint sized to the slide', async () => {
    const live = runtime();
    const result = await run(live, ['slides', 'media', 'label:Cover', '/w/clip.mp4']);
    assert.equal(result.result.kind, 'video');
    assert.deepEqual([result.result.width, result.result.height], [1920, 1080]);
    const node = live.slide.children[0];
    assert.deepEqual(node.fills, [{ type: 'VIDEO', scaleMode: 'FILL', videoHash: 'vid' }]);
  });

  it('resolves a slide by label when the canvas grid has not listed it yet', async () => {
    const live = runtime();
    const ghost = {
      id: '1:9', name: '9', type: 'SLIDE', width: 1920, height: 1080, children: [],
      getPluginData(key) { return key === SLIDE_LABEL_KEY ? 'Stray' : ''; },
      appendChild(child) { this.children.push(child); child.parent = this; },
    };
    live.nodes.set(ghost.id, ghost);
    live.figma.currentPage = { children: [{ type: 'SLIDE_ROW', children: [live.slide, ghost] }] };
    const result = await run(live, ['slides', 'media', 'label:Stray', '/w/shot.png']);
    assert.equal(result.result.slideId, '1:9');
    assert.equal(ghost.children.length, 1);

    const fuzzy = await run(live, ['slides', 'media', 'stra', '/w/shot.png']);
    assert.equal(fuzzy.result.slideId, '1:9', 'a bare query matches an unlisted slide by substring');
    assert.equal(ghost.children.length, 2);
  });

  it('refuses a file larger than the eval payload can carry, before reading it', () => {
    const live = runtime();
    const io = workspace({ size: SLIDES_MEDIA_HARD_LIMIT + 1 });
    // prepare refuses synchronously, before any Figma call is generated.
    assert.throws(
      () => run(live, ['slides', 'media', 'label:Cover', '/w/big.mp4'], io),
      /over the 3500000 byte ceiling/,
    );
  });

  it('reports a runtime without the primitive instead of guessing', async () => {
    const noGif = runtime({ hasCreateGif: false });
    await assert.rejects(
      () => run(noGif, ['slides', 'media', 'label:Cover', '/w/loop.gif']),
      /does not expose createGif/,
    );
    const noVideo = runtime({ hasCreateVideo: false });
    await assert.rejects(
      () => run(noVideo, ['slides', 'media', 'label:Cover', '/w/clip.mp4']),
      /does not expose createVideoAsync/,
    );
  });

  it('removes the node it created when the insert cannot be verified', async () => {
    const live = runtime({ appendRefuses: true });
    await assert.rejects(
      () => run(live, ['slides', 'media', 'label:Cover', '/w/shot.png']),
      (error) => {
        assert.equal(error.mutationOutcome, 'rolled-back');
        assert.match(error.message, /did not accept the media node/);
        return true;
      },
    );
    assert.equal(live.slide.children.length, 0);
    assert.equal([...live.nodes.keys()].length, 1, 'only the slide is left');
  });

  it('refuses a slide reference it cannot resolve, before creating anything', async () => {
    const live = runtime();
    await assert.rejects(
      () => run(live, ['slides', 'media', 'label:missing', '/w/shot.png']),
      /Slide not found/,
    );
    assert.equal(live.slide.children.length, 0);
  });

  it('refuses a non-Slides editor', async () => {
    const live = runtime({ editorType: 'figma' });
    await assert.rejects(
      () => run(live, ['slides', 'media', 'label:Cover', '/w/shot.png']),
      /requires a Figma Slides deck/,
    );
  });

  it('will not generate code from unprepared input', () => {
    assert.throws(
      () => slidesMediaCode({ request: parseSlidesMediaRequest(['slides', 'media', 'label:A', '/w/a.png']), sourceBase64: 'AAAA' }),
      /authentic prepared input/,
      'the base64 payload may only come from an authorized workspace read',
    );
  });
});
