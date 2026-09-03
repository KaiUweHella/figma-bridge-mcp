# 0129. Own the Motion round trip between CSS animations and Figma Motion

Date: 2026-09-02

## Status

Accepted

## Context

Figma Motion (manual keyframe tracks on layers, one timeline per top-level
frame) and CSS animations describe the same intent, but the Bridge carried
neither direction. Design Capture dropped `manualKeyframeTracks`, so a Figma
animation never reached a Code Spec; Browser DOM Capture read computed styles
while animations were running and knew nothing about `@keyframes`, so a
CSS-animated page rendered into Figma as static layers with mid-animation
geometry. The Motion write commands also failed on every real file: Figma
canonicalizes a written track (ids, `baseValue`, `keyframeOperation`, default
easing expanded to its cubic-bezier, float32 numbers) and the postcondition
compared that readback with the raw binding, so each write was rolled back as
"postcondition drift".

## Decision

- **Motion Capture.** The walker records a node's native
  `manualKeyframeTracks` and its owning timelines as a bounded raw fact.
  Code Spec projects it (`projectMotion`) to sorted keyframes without ids and
  with float32 noise rounded away; unsupported track shapes are listed, never
  dropped silently.
- **Motion Projection to CSS.** `motionToCss` turns one projected fact into
  `@keyframes` plus an `animation` declaration. Translation, scale and rotation
  tracks compose one `transform` per keyframe (missing components are
  interpolated with the segment's easing so CSS never snaps them to identity);
  opacity, sizes, radii, gaps, paddings and first-paint colours map to their
  CSS properties. Figma stores the easing on the keyframe it arrives at while
  CSS applies a keyframe's timing function to the segment that leaves it, so
  the projection shifts each easing one keyframe back. Named Figma easings
  use their own bezier expansion; springs, Variable-bound easings and fields
  without a CSS equivalent become explicit limitations with a neutral
  fallback (ADR 0099). The tree spec shows a `motion:` segment per layer and a
  `## Motion (implement as CSS)` section; the structured model carries
  `motion` with its `css` projection.
- **Motion translation from CSS.** Browser DOM Capture reads every element's
  computed animation facts and the referenced `@keyframes` rules first, then
  pauses playback with an injected `animation: none !important` style so the
  captured geometry and paint are resting values, and removes the style
  afterwards. `cssAnimationToMotion` synthesizes the implicit 0 %/100 %
  keyframes from resting values, honours `reverse`, writes one period for
  repeated animations (two for `alternate`), rotates the period for negative
  delays (the phase origin is interpolated with the segment's easing) and
  shifts positive delays. The inverse easing convention keeps a round trip
  stable.
- **One timeline per frame.** Every layer on a Figma frame shares that frame's
  timeline, which is the longest animation on it. A shorter endless loop is
  therefore repeated by `repeatMotionToTimeline` until it fills that timeline;
  a timeline that cuts mid-cycle gets a final keyframe interpolated on the
  segment's own easing curve, which is what an author does by hand. Only an
  endless, undelayed loop with one shared cycle across its contributing
  animations is repeatable; anything else keeps its own length and is reported
  as a layer that holds its last value while its siblings keep moving. Without
  this a 3.8 s float next to a 10 s orbit froze for 6.2 s of every cycle.
- **Semantic Render Plan.** A node may carry `motion` = `{ duration, tracks }`
  in Figma's own track shape; the plan validator closes field names, value
  types, easing types and bounds (64 tracks, 256 keyframes, monotonic times
  inside the duration). The executor applies each track with
  `applyManualKeyframeTrack` after creating the layer, grows the root
  timeline to the longest track and reports `motionReport`
  (nodes, tracks, duration, timeline, skipped, failures). Motion is additive:
  a layer that rejects a track is reported, never a reason to fail the render.
- **Motion writes.** Track postconditions compare semantic keyframe content
  (position, value and the authored easing type/function at float32
  precision); ids, `baseValue`, `keyframeOperation` and Figma's default easing
  fill are not drift.

## Consequences

- A Figma animation reaches code as exact CSS with the design's own curves;
  the design-to-code skill implements it CSS-first with a
  `prefers-reduced-motion` override.
- A CSS animation reaches Figma as native keyframe tracks on the rendered
  layer or component, so Figma's Motion panel edits the same intent.
- Loops remain a documented boundary: Figma timelines play once, so
  `iteration-count`/`direction` are re-added in code, and springs are never
  approximated. Inside one frame the boundary is paid for by repeating the
  period, so layers stay in sync for the whole timeline.
- `render --dom-capture` reports the captured animations with their
  limitations and, after the write, the tracks Figma accepted. A motion
  outcome is never applied silently.
- `motion apply/add/preset/stagger` succeed on real files again.
