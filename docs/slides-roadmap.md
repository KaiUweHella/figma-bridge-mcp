# Figma Slides beta roadmap

Last reviewed against `@figma/plugin-typings` 1.133.0 on 2026-08-10.

This roadmap distinguishes product work from Figma Plugin API boundaries. An
item being desirable does not imply that the public API can currently perform
it. All supported operations remain CLI-first and use the existing
authenticated Bridge Daemon and plugin transport.

## Beta contract delivered in 0.4.0

| Command                             | Contract                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `slides inspect [slide]`            | Read the native canvas grid, focus, names, coordinates, skip state, transition and child count                                           |
| `slides create [label]`             | Create and focus a slide, optionally at a zero-based row/column; store a durable Bridge label because Figma renumbers native slide names |
| `slides duplicate <slide>`          | Clone one explicit slide, add an optional durable `--label`, and move the copy to the end or an existing coordinate                      |
| `slides move <slide> <row> <col>`   | Move one explicit slide through `moveNodesToCoord`                                                                                       |
| `slides transition <slide> <style>` | Set the native style, duration, curve and click/delay timing                                                                             |
| `slides skip <slide> [on\|off]`     | Set presentation skip state explicitly                                                                                                   |
| `slides delete <slide>`             | Delete one id/exact-name/unique-substring match; ambiguity refuses                                                                       |

The implementation uses the current `getCanvasGrid` and `moveNodesToCoord`
APIs rather than the deprecated Slide Grid setters. Every snippet rejects other
editors before calling a Slides-only API. Mutations use the normal Capability
Catalog and write-confirmation gate. Native slide names are presentation
numbers and are rewritten on grid changes, so stable labels use plugin data and
are reported separately. Duplicate and move preflight their target row/column;
only create may establish a new row through the documented `createSlide` API.

Slide references are discriminated before target resolution. `node:<id-or-URL>`
selects only node identity and may derive a file target; `name:<literal>` and
`label:<literal>` select only their named Slides fact. Bare values canonicalize
to the compatible `query:` lookup and never let a URL-shaped authored name or
label change the target file.

## Next candidates

### P1 — make existing slide content agent-legible

- Inspect a slide's text, media, components and interactive elements as a
  compact structured model rather than only returning `childCount`.
- Add slide-scoped accessibility and overflow checks.
- ~~Reuse the existing render pipeline with one explicit target slide. Do not
  introduce a Slides-only renderer or a second transport.~~ **Delivered**
  (ADR 0130): `render --slide <nodeId>` renders a Semantic Render Plan into one
  named slide. The Dispatch Receipt guard admits exactly `render-plan` +
  `slides` + a well-formed slide id; `render-plan-batch` and every other editor
  stay refused. The executor resolves the target before any mutation and places
  the root in the slide's own coordinate space. Slide ids come from
  `slides inspect`; `name:`/`label:` references are not accepted, because
  resolving one needs a read and an ambiguous reference must never let a render
  choose its own target.
- Add row creation and row-level movement only if their destructive semantics
  can be made as explicit as slide movement.

### P2 — safe bulk deck operations

- Batch create/duplicate/move with a complete dry-run plan and exact ids.
  Note before building this: three plugin execution timeouts were observed in
  one session, one of which left an empty slide behind while reporting an
  unknown outcome. A command that bundles several mutations under one dispatch
  makes that failure mode more expensive, not less, so the dry-run must be the
  default and `--apply` the deliberate step.
- ~~Deck linting for duplicate names, skipped-slide placement, missing
  transitions and empty slides.~~ **Delivered**: `slides lint` with `--kinds`,
  `--limit` and `--fail-on-issues`. Findings follow the `analyze lint` shape,
  and the header counts must reconcile with the issue list. The deck's first
  slide is exempt from `missing-transition`, because it has nothing to
  transition from. Its first live run found real residue — an empty slide left
  by a timed-out `slides create` — and a transition that had silently reset.
- ~~Export a compact deck manifest suitable for review and version control.~~
  **Delivered**: `slides manifest`. It returns the projection as the command
  result rather than writing a file, so the Application keeps
  `effects.workspace: 'none'`; persisting it stays the caller's decision.
- Add a dedicated acceptance fixture that can be created, read back and removed
  without touching unrelated slides. The 2026-08-10 live run established the
  pattern; turn it into a repeatable maintainer checklist or opt-in smoke tool.

### P3 — media and interactive content where the API permits it

- Inspect existing `INTERACTIVE_SLIDE_ELEMENT` nodes and report their native
  type (`POLL`, `EMBED`, `FACEPILE`, `ALIGNMENT`, `YOUTUBE`).
- Evaluate link previews/embeds only after confirming their network and consent
  behavior fits the loopback-only security model.
- Evaluate video insertion using existing Plugin API media primitives and the
  same asset-input policy as Figma Design.
- Add viewport/focus helpers only when they improve a concrete authoring or
  verification workflow; do not automate presentation playback for its own
  sake.

## Verified against the installed typings (1.133.0, 2026-09-02)

A re-audit of `@figma/plugin-typings` 1.133.0 for the P3 items:

- `InteractiveSlideElementNode` declares `type` and
  `interactiveSlideElementType: 'POLL' | 'EMBED' | 'FACEPILE' | 'ALIGNMENT' |
'YOUTUBE'` — **readable**. Its only method is `clone()`; no
  `createInteractiveSlideElement` factory exists, so authoring one stays
  blocked.
- `createGif` and `createLinkPreviewAsync` are documented in the typings
  themselves as "only available in FigJam" — **blocked for Slides**, so the
  link-preview network question is moot here.
- `createVideoAsync(data)` carries no editor restriction, only a paid-team
  restriction. `Video` exposes nothing but `hash` (no `getBytesAsync`/
  `getSizeAsync`, unlike `Image`), so a written video cannot be read back the
  way an image can.
- `PageNode.focusedSlide`, `PageNode.focusedNode`, `ViewportAPI.slidesView` and
  `ViewportAPI.canvasView` are all declared as getters _and_ setters — viewport
  and focus helpers are implementable whenever a concrete workflow needs them.
- `createSlideRow(row?)` is declared and not deprecated: the row-level gap in
  P1 is a product decision about destructive semantics, not an API gap.
  `SlideGridNode.clone()` is typed but documented to throw at runtime.
- Speaker notes remain absent from the typings entirely — no member of any name
  on `SlideNode` or `PluginAPI`.

## Currently blocked by the public Plugin API

- Creating native polls, facepiles, alignment activities, and specialized
  YouTube interactive elements: the typings expose their node type and cloning,
  but no public create method.
- Reading or writing speaker notes: no speaker-notes surface is declared in the
  installed Plugin API typings.
- Any future Slides feature that only exists in the UI must remain documented
  as blocked until it appears in the official typings and passes a live check.

Blocked items should be re-evaluated when `api gap` detects new Slides symbols
or when `@figma/plugin-typings` is upgraded. They must not be emulated through
CDP, binary patching, or undocumented/private calls.

## Exit criteria for beta

Slides can lose the beta label only when all of the following are true:

1. Every public command has deterministic unit/contract coverage and a
   maintainer-only Figma Desktop acceptance record. This is satisfied for the
   current beta surface as of 2026-08-10 and must stay current.
2. The surface has been exercised on a fresh deck and a populated deck without
   moving or deleting unrelated slides.
3. Readback proves every mutation, including coordinates, transition timing and
   skip state.
4. The supported/blocked table has been reviewed against the then-current
   official Plugin API typings.
5. There are no known implicit whole-deck mutations or ambiguous target
   fallbacks.

One successful local smoke test is necessary evidence, but not enough on its
own to remove the beta label.
