# 0130. Own one explicit render target for Figma Slides

## Status

Accepted.

## Context

Figma Slides content could not be authored through the Bridge at all. The
supported Slides surface was grid-level — inspect, create, duplicate, move,
transition, skip, delete — and `docs/slides-roadmap.md` carried the gap as a P1
candidate: "reuse the existing render pipeline with one explicit target slide.
Do not introduce a Slides-only renderer or a second transport."

Two facts made the gap sharper than the roadmap text suggested.

First, `render-plan` and `render-plan-batch` were refused outright outside
Figma Design. The refusal is correct as a default — a Render Plan carries
Design semantics — but it left no way in, so a deck built from code was
impossible.

Second, there was a way in, and it was the wrong one. The legacy
"generated eval compatibility" executor is not editor-gated, so a render whose
native preflight rejected any fact fell back to it and succeeded in a Slides
file. Authoring a real eight-slide deck that way worked, but only by including
a prop the native executor does not support purely to trigger the fallback. It
also exposed why an implicit target is unacceptable: in the Slides editor
`figma.currentPage` resolves to whichever slide is _focused_, so a render lands
inside that slide by accident of UI state rather than by request.

## Decision

- **One explicit target, or nothing.** `render --slide <nodeId>` names the
  slide. The value is a Figma node id; `name:` and `label:` references are
  deliberately not accepted, because resolving them needs a document read and a
  render must never pick its own target when a reference turns out ambiguous.
  Slide ids come from `slides inspect`.
- **The editor follows the request.** `expectedEditorForCommand` returns
  `slides` when the render names a slide, so the target is derived from argv
  rather than from whichever window is focused.
- **The guard narrows instead of opening.** `validatePreparedDispatchContext`
  still refuses Render Plans outside Figma Design, with one exception: action
  `render-plan`, editor `slides`, and a well-formed slide id supplied by the
  same request payload the plugin is about to execute. `render-plan-batch`
  stays refused in Slides — a batch spreads several roots across a canvas,
  which has no meaning inside one slide. FigJam and Dev Mode stay closed even
  when a slide-shaped target is present.
- **The target is resolved before any mutation.** The executor resolves the id,
  requires `type === 'SLIDE'`, and refuses with `no-mutation` when the node is
  missing or wrong-typed, so a rejected target can never leave a frame on a
  slide grid. On success the created root is appended to that slide and placed
  in the slide's own coordinate space, defaulting to its origin.
- **No new transport.** The same `render-plan` action, protocol payload,
  Dispatch Receipt and Semantic Render Plan carry the work; `options.slide`
  joins the existing closed option set.

## Consequences

- Slide content is authored through the native Semantic Render Plan, with the
  structural audit, variable report, text-style report and motion report that
  every other render gets. It no longer depends on a compatibility fallback.
- A render into a slide is reproducible from its argv alone: the slide id is in
  the command, not in the editor's focus.
- The Slides surface stays otherwise grid-level. Batch rendering, slide content
  inspection and deck-level linting remain separate roadmap items.
- Because the guard is part of the runtime synced into the plugin bundle, this
  change bumps the plugin build to 3.3.41 and requires the development plugin
  to be relaunched in Figma before a live render into a slide will be accepted.
