# Figma Slides beta roadmap

Last reviewed against `@figma/plugin-typings` 1.136.0 on 2026-09-03. The
1.133.0 → 1.136.0 diff adds `textWrapStyle` (`AUTO | BALANCE | PRETTY`, with
`getRangeTextWrapStyle`/`setRangeTextWrapStyle`) and restores `getCSSAsync`;
the rest is formatting. No Slides symbol changed, so the P3 audit below,
made against 1.133.0 on 2026-09-02 and confirmed on the live runtime, stands.
The bump went through the pinned review: audited version in
`api-operation-coverage.js`, reviewed source digest in
`api-reference-policy.js`, the operation audit and the Style Facts union
drift check. Note that `api gap` compares the typings with this engine's
source tree; runtime availability is measured separately, as the audit
section describes.

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

- ~~Batch create/duplicate/move with a complete dry-run plan and exact ids.~~
  **Delivered**: `slides batch '<json>' [--apply]`. The plan is the default and
  `--apply` the deliberate step, so the Capability Catalog classifies the plan
  as a read (`effects.figma: 'read'`) and only `--apply` as a write. That
  default was chosen because three plugin execution timeouts were observed in
  one session, one of which left an empty slide behind while reporting an
  unknown outcome: a command bundling several mutations behind one dispatch
  makes that failure mode more expensive, not less.
  Up to 64 heterogeneous items (`create`, `duplicate`, `move`). Every
  reference is resolved and every coordinate validated against **one** grid
  snapshot before anything is written; a coordinate that would only become
  valid because of an earlier item in the same batch is refused rather than
  guessed, because simulating Figma's insertion semantics would let a subtly
  wrong model authorize a wrong write. Two items targeting the same slide are
  refused for the same reason. Application is sequential with a fresh readback
  per item, and the first failure reverses everything already applied: there is
  no partial success, only `verified`, `rolled-back` or `partial-residue`.
  A reversal looks before it acts — a move whose call threw without moving
  anything is restored by observation, not by re-calling the API that just
  failed.
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

- ~~Inspect existing `INTERACTIVE_SLIDE_ELEMENT` nodes and report their native
  type (`POLL`, `EMBED`, `FACEPILE`, `ALIGNMENT`, `YOUTUBE`).~~ **Delivered**:
  `slides manifest` inventories them per slide, walking the subtree under a
  node and per-slide budget and reporting `interactiveTruncated` when a budget
  is hit. A type the installed typings do not declare is reported as `UNKNOWN`
  rather than passed through as a new fact. Reading is the whole capability:
  the typings declare `clone()` and no create factory, so authoring one stays
  blocked.
- Evaluate link previews/embeds only after confirming their network and consent
  behavior fits the loopback-only security model.
- ~~Evaluate video insertion using existing Plugin API media primitives and the
  same asset-input policy as Figma Design.~~ **Delivered**:
  `slides media <slide> <file>` inserts a still image, an animated GIF or a
  video into one named slide, reusing the same WorkspaceIO authorization the
  Design image commands use. Live-verified in Slides: a GIF arrives as a
  playable `MEDIA` node (`createGif`), a still as an `IMAGE` paint at its
  natural size fitted to the slide, and a video as a `VIDEO` paint. A created
  node is removed again if the insert cannot be verified.
  The ceiling is **~3.5 MB of file bytes**, not the 8 MB `IMAGE_HARD_LIMIT`
  other image commands advertise: inbound bytes ride inside the eval payload
  (the asset stream is an export path only) and base64 inflates them by 4/3
  against a 5 MB protocol limit. `IMAGE_HARD_LIMIT` is therefore unreachable
  by arithmetic — an 8 MB image becomes ~10.7 MB of base64 — and a file
  between ~3.7 and 8 MB failed at the transport with a protocol error instead
  of that command's friendly size message. Aligned since: `IMAGE_HARD_LIMIT`
  is the shared 3.5 MB ceiling, `slides media` re-exports it, and a render
  additionally measures its whole plan payload before dispatch, because
  several images that each fit still share one protocol value.
- ~~Add viewport/focus helpers only when they improve a concrete authoring or
  verification workflow; do not automate presentation playback for its own
  sake.~~ **Delivered**: `slides focus <slide>` and `slides view <grid |
single-slide>`. Both use surfaces the typings declare as settable
  (`PageNode.focusedSlide`, `ViewportAPI.slidesView`) and both verify by
  reading the value back, so a change Figma silently refuses is reported as a
  refusal rather than as success. Neither changes the document: both report
  `effects.figma: 'read'` with `effects.editor: 'write'` and are therefore not
  gated by write confirmation. The concrete workflow they serve is
  verification — focusing the slide a render targeted, and switching to
  single-slide view before a screenshot. Presentation playback is still not
  automated.

Full probe transcripts and live command output for the items in this document
are kept in the maintainer-local acceptance record under
`docs-local/live-tests/`, which is not part of the repository — session
bookkeeping rather than something the repo should carry.

## Refusal messages name the reason (resolved 2026-09-03)

Invalid argv for any Slides subcommand used to be refused with the generic
"Command not allowed: slides &lt;verb&gt;", so `slides view sideways` read as if
the verb were disallowed when the mode was the problem. Fixed once, at the
Capability Catalog's rejection projection (`explainFigmaCommandRejection`):
every Slides action now maps to its own parser there, and the parser's reason
is shown when it carries no caller payload — option names, closed value sets,
bounds and Union Reference codes. A reason that would echo an argument (an
unknown lint kind, an unknown batch field) stays generic. The in-process
Command Application appends the same projection to its "Command not allowed"
error, so the CLI and `figma_run` explain the same refusal the same way.

## getCanvasGrid() can lag the page tree for minutes (2026-09-03)

The most consequential finding of the session, and it invalidated a claim every
Slides command rested on. The first write-up of it here was itself wrong about
the cause, and the correction matters — see the end of this section.

A timed-out `slides create` left slide `15:287` behind. It was a live `SLIDE`,
`removed === false`, whose parent was `SLIDE_ROW 7:21` on the current page —
and `figma.getCanvasGrid()` did not list it. Measured directly against the
page tree:

```
page tree : 9 slides, row 7:21 = [7:12, 7:14, 7:16, 7:18, 15:287]
grid      : 8 slides
```

Everything that walked only the grid was blind to it. `slides lint` reported
"no findings across 8 slide(s)" on a nine-slide deck whose ninth slide was
empty and had no transition — wrong, and silently so.

Fixed where the fix is shared: `slideDeckFactsFragment` now reconciles the grid
against the page tree. The grid stays authoritative for **coordinates**; the
page tree is authoritative for **existence**. A slide the grid omits is
reported with `row`/`col` `null`, listed under `unlisted` by `slides manifest`,
and flagged by a new `unlisted-slide` lint kind. `slides inspect`, `lint`,
`manifest` and the `batch` preflight all gained this at once — the payoff of
having extracted the fragment.

**Correction to the first write-up.** This was initially recorded as a
permanent inventory gap — "stable across daemon restarts, so not eventual
consistency". That was wrong. The grid did eventually catch up: the same slide
later reported coordinate `[1,4]`, and `slides delete` then removed it
normally. So the grid _lags_ the page tree, by minutes and across daemon
restarts and dozens of intervening commands, but it does settle. The claim was
made from a long observation window rather than from an unbounded one, which is
exactly the mistake this document already warns about for typings comments.

What that changes, and what it does not:

- The reconciliation stays correct and necessary. A reader must not
  under-report a deck, or refuse to read it, during a lag that can outlast a
  whole working session. `slides lint` calling a nine-slide deck clean was
  wrong regardless of whether the grid would settle later.
- The gap in the mutation commands was a **window**, not a permanent hole,
  and it is closed since 2026-09-03: every mutation snapshot splices the same
  page-tree walk (`slidePageSlidesFragment`) and carries the unlisted ids in
  its strict before/after comparison. `delete` verifies an unlisted slide by
  node existence, `duplicate`, `transition` and `skip` accept one as target,
  and `move` refuses one with the reason — without a grid coordinate there is
  no origin to restore on rollback. `media` and `focus` resolve names and
  labels over the page tree too. A focus resting on an unlisted slide no
  longer makes every mutation refuse. Live-verified on 2026-09-03 against a
  deck whose grid was lagging: `create` landed a slide the grid did not list,
  `manifest` reported it as unlisted, `focus`, `skip` and `transition` reached
  it, and it later appeared at a coordinate and was duplicated normally.
- The grid also fails the other way round. After a slide is removed it can
  keep the dead id and throw `The node with id "…" does not exist` on every
  read, for minutes (measured 2026-09-03 after deleting a duplicate). The
  deck walk now treats a throwing grid as empty and remembers the reason:
  readers list the deck from the page tree with no coordinates and say why,
  mutations refuse with the runtime's message.
- Two of the session's "Plugin disconnected" failures were not Figma's doing
  at all: every MCP server start copied the plugin bundle unconditionally,
  and Figma reloads a development plugin whenever its files change on disk.
  Fixed in `connect` (write only when bytes differ). The 59-second execution
  timeouts of earlier acceptance sessions most likely had the same cause. That is far less severe than first recorded, and it
  lowers the priority of giving those snapshots the same reconciliation —
  though a command that refuses a slide the user can see is still a poor
  answer, and the fix would also need verification by node existence rather
  than grid difference.

## Observed Figma behaviour worth knowing (2026-09-02)

Two things that only live runs showed, both now handled rather than assumed:

- **The canvas grid is eventually consistent.** `getCanvasGrid()` does not
  always list a slide in the same plugin eval that created or moved it. A batch
  therefore verifies identity and label immediately but reports an unobserved
  grid position as unobserved (`gridObserved: false`) instead of rolling a
  correct write back. A position that _is_ observed and disagrees with the
  request still fails and reverses. Before this was understood, a `create` with
  an explicit coordinate failed its own readback every time.
- **A last-slide transition resets to `NONE`.** Creating a slide after the
  deck's final slide and deleting it again leaves that final slide with no
  transition. Reproduced three times in one session against the same deck, and
  found by `slides lint` each time rather than by reading the deck. The Bridge
  writes no transition in that path, so this looks like Figma's own grid
  bookkeeping; worth a narrow reproduction against a scratch deck before
  reporting it upstream.

## Verified against the installed typings (1.133.0, 2026-09-02; unchanged in 1.136.0)

A re-audit of `@figma/plugin-typings` 1.133.0 for the P3 items:

- `InteractiveSlideElementNode` declares `type` and
  `interactiveSlideElementType: 'POLL' | 'EMBED' | 'FACEPILE' | 'ALIGNMENT' |
'YOUTUBE'` — **readable**. Its only method is `clone()`; no
  `createInteractiveSlideElement` factory exists, so authoring one stays
  blocked.
- `createGif` and `createLinkPreviewAsync` both carry the typings' note "only
  available in FigJam". **That note is not a runtime fact, and only one of the
  two is actually blocked.** Measured in a live Slides file on 2026-09-03:
  `typeof figma.createGif === 'function'`, and calling it there fails with
  `in createGif: Invalid SHA1 hash` — an argument complaint, not an editor
  refusal — so the API is live in Slides. `figma.createLinkPreviewAsync` is
  `undefined` in the Slides runtime and is genuinely unavailable.
  The lesson generalises: a doc comment in the typings states availability, it
  does not enforce it. Availability claims that gate our own surface must be
  probed, not quoted.
- `createVideoAsync(data)` carries no editor restriction, only a paid-team
  restriction. `Video` exposes nothing but `hash` (no `getBytesAsync`/
  `getSizeAsync`, unlike `Image`), so a written video cannot be read back the
  way an image can. Live probe: it exists in Slides and fails on file type
  (`Video file type must be MP4, MOV, or WebM.`), never on the editor.
- `PageNode.focusedSlide`, `PageNode.focusedNode`, `ViewportAPI.slidesView` and
  `ViewportAPI.canvasView` are all declared as getters _and_ setters — viewport
  and focus helpers are implementable whenever a concrete workflow needs them.
- `createSlideRow(row?)` is declared and not deprecated: the row-level gap in
  P1 is a product decision about destructive semantics, not an API gap.
  `SlideGridNode.clone()` is typed but documented to throw at runtime.
- Speaker notes remain absent from the typings entirely — no member of any name
  on `SlideNode` or `PluginAPI`. Confirmed on the live runtime as well: no own
  or prototype member of a real `SLIDE` node matches `/note|speaker/`. This one
  is genuinely blocked, not a documentation artefact.

## Currently blocked by the public Plugin API

Each item below was checked against the live Slides runtime, not only against
the typings, after a doc comment turned out to overstate one restriction.

- Creating native polls, facepiles, alignment activities, and specialized
  YouTube interactive elements: the typings expose their node type and cloning,
  but no public create method. Reading them is delivered (`slides manifest`).
- Reading or writing speaker notes: no speaker-notes surface is declared in the
  installed Plugin API typings, and none exists on a live slide node.
- Link previews and embeds: `createLinkPreviewAsync` is `undefined` in the
  Slides runtime.

Not blocked, and available to build when a workflow needs it: GIF and video
insertion. `createGif` and `createVideoAsync` are both callable in Slides
despite the typings' FigJam note; what they need is the same asset-input policy
Figma Design media already uses, not a new capability decision.

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
