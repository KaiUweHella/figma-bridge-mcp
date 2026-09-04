# Editors — design decisions

Figma has more than one editor surface, and a command written for Figma
Design does not automatically mean something safe in Slides, FigJam or Dev
Mode. The decisions below keep every editor on the same authenticated
transport, make each Slides-only or FigJam-only call check the editor first,
and stop a render or a mutation from landing on a target the request never
named.

## Rendering into Figma Slides

### Render into a named slide, never a focused one

**Decision.** `render --slide <nodeId>` is the only way to author slide
content from code. The value must be an actual Figma node id from
`slides inspect`; `name:` and `label:` references are deliberately not
accepted, because resolving those needs a document read, and a render must
never pick its own target when a reference turns out ambiguous.
**Why.** Inside the Slides editor, `figma.currentPage` resolves to whichever
slide is currently focused, so an implicit target would make a render's
outcome depend on what a human happened to be looking at.
**What it means for you.**

- The requested editor is derived from `--slide` being present, not from
  whichever window is focused.
- A missing or wrong-typed target refuses with `no-mutation` and touches
  nothing.

<!-- source: 0130 -->

### Open the render guard only for a well-formed slide target

**Decision.** Render Plans stay refused outside Figma Design, with one
exception: a single-root render naming editor `slides` and a well-formed
slide id. Batch rendering stays refused in Slides, since spreading several
roots across a canvas has no meaning inside one slide, and FigJam and Dev
Mode stay closed regardless of target. No new transport was introduced.
**Why.** The previous route into a slide was a "generated eval" compatibility
path that is not editor-gated at all: it worked only by including a prop the
native executor did not support, purely to trigger it.
**What it means for you.**

- A slide render gets the same structural, variable, text-style and motion
  reports as any other render, with no compatibility fallback.
- The created root is appended to the target slide, placed in that slide's
  own coordinate space, defaulting to its origin.

<!-- source: 0130 -->

## Reading and mutating a Slides deck

### Check the editor before every Slides-only call

**Decision.** Every Slides operation checks `figma.editorType === "slides"`
before it touches a Slides-only API, and uses `getCanvasGrid` and
`moveNodesToCoord` rather than the deprecated grid setters. Native slide
names are presentation numbers that Figma rewrites whenever the grid changes,
so durable labels live in plugin data and are reported separately.
**Why.** A Slides API called in Design or FigJam throws late and leaves an
uncertain write behind; a slide addressed by its native name stops resolving
as soon as a neighbour is inserted.
**What it means for you.**

- `create` takes an optional label and `duplicate` takes `--label`; `inspect`
  and `manifest` report both `name` and `label`.
- References resolve by id, exact name or label, then unique substring;
  `node:`, `name:` and `label:` prefixes restrict the lookup, and ambiguity
  is refused rather than guessed.

### Treat the grid as the source of coordinates and the page tree as the source of existence

**Decision.** `figma.getCanvasGrid()` is authoritative for a slide's row and
column; the page tree is authoritative for whether a slide exists. Every
reader and every mutation snapshot reconciles the two. A slide the grid has
not listed is reported with `row` and `col` `null`, listed under `unlisted`,
and flagged by the `unlisted-slide` lint kind; a grid that throws is treated
as empty with the reason remembered.
**Why.** The grid lags the page tree, sometimes for minutes, and after a
removal it can keep a dead id and throw on every read. Walking only the grid
made a nine-slide deck lint clean while one slide was missing.
**What it means for you.**

- `inspect`, `manifest` and `lint` never refuse a deck because of the grid;
  `manifest` says why positions are unknown when the grid cannot be read.
- `delete`, `transition`, `skip`, `media` and `focus` reach an unlisted slide;
  `move` refuses one with the reason, because without a coordinate there is
  no origin to restore on rollback.
- A `create` whose slide the grid has not listed yet is verified by identity,
  label, focus and selection and reported as `gridObserved: false`.

### Plan bulk deck edits before applying them

**Decision.** `slides batch` plans by default and performs nothing until
`--apply`. Every reference and coordinate is validated against one grid
snapshot before any write; a coordinate that would only become valid because
of an earlier item in the same batch is refused, two items targeting the same
slide are refused, and the first failing item reverses everything applied
before it. Row-level operations are deliberately not offered.
**Why.** Plugin execution timeouts leave residue with an unknown outcome, and
a command bundling several mutations behind one dispatch makes that failure
mode more expensive. Simulating Figma's insertion semantics would let a
subtly wrong model authorize a wrong write.
**What it means for you.**

- The cheap way to find out what a batch would do is never the one that
  performs it; the catalog classifies the plan as a read and `--apply` as a
  write.
- Outcomes are `verified`, `rolled-back` or `partial-residue`, never partial
  success.

### Insert media through the payload, and say where the ceiling is

**Decision.** `slides media <slide> <file>` inserts a still image, an animated
GIF or a video into one slide through the same workspace authorization the
Design image commands use. The file rides inside the plugin payload as base64,
so the ceiling is the shared 3.5 MB image limit, and a created node is
removed again when the insert cannot be verified.
**Why.** The asset stream is an export path only; there is no inbound
streaming, and an advertised ceiling the transport cannot carry produces a
protocol error instead of guidance.
**What it means for you.**

- Availability was measured against the live runtime, not read from a typings
  comment: `createGif` and `createVideoAsync` work in Slides.
- Speaker notes, link previews and creating polls, facepiles or embeds have no
  public API and stay refused rather than emulated.

### Move the editor's context without writing the document

**Decision.** `slides focus <slide>` and `slides view <grid | single-slide>`
set `PageNode.focusedSlide` and `ViewportAPI.slidesView`, verify by reading
the value back, and report a change Figma silently declines as a refusal.
Neither changes the document, so both report `effects.figma: 'read'` with
`effects.editor: 'write'` and are not gated by write confirmation.
**Why.** The workflow they serve is verification: focusing the slide a render
targeted and switching to single-slide view before a screenshot. Presentation
playback is not automated.
**What it means for you.**

- A focus resting on a slide the grid has not listed does not block any
  mutation.
- An unresolvable reference or an undeclared view mode is refused with the
  reason.

## FigJam and Dev Mode

### Run FigJam over the same bridge with explicit placement

**Decision.** The plugin runs in FigJam boards over the same authenticated
transport; there is no second transport and no extra permission. `jam`
commands create stickies, shapes, connectors and tables, read the whole board
back with its connectors, and arrange only what the call names: the current
selection by default, `--ids` for a list, `--all` explicitly for the page.
**Why.** A board-wide arrange or an implicit "everything" mutation is exactly
the fan-out the one-file-per-command rule exists to prevent.
**What it means for you.**

- New nodes land to the right of what is already on the board unless a
  position is passed.
- FigJam-only APIs are guarded by the editor type the same way Slides-only
  APIs are; a Render Plan stays refused in FigJam.

### Give Dev Mode its own read-only manifest

**Decision.** Dev Mode uses a separate plugin manifest bundle, because Figma
does not support combining the FigJam editor target with `dev` in one
manifest. In Dev Mode the bridge stays connected for selection, inspection,
specs and exports; rendering and canvas edits require Design mode and the
normal plugin.
**Why.** Dev Mode is read-only by Figma's own contract, and a bundle that
pretends otherwise would fail at the mutation rather than at the request.
**What it means for you.**

- Import the `dev-mode/manifest.json` bundle for Dev Mode and the normal
  manifest for Design and FigJam.
- Measurements, annotations and Dev Resources are readable there; writes are
  refused before dispatch.
