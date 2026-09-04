# Code-to-Figma — design decisions

Code-to-Figma turns a Semantic Render Plan, JSX, or a captured DOM into
native Figma nodes. The decisions below protect the boundary between what
the Bridge can prove about a plan before it touches the canvas and what only
a live Figma document can settle, and they keep sizing, text, images, and
motion faithful to their source intent rather than approximated.

## Semantic Render Plan and execution

### Journal every resource a render creates

**Decision.** Native Semantic Render execution uses one request-scoped
mutation journal. Structural validation and a mutation-free resource
preflight run first, resolving fonts, component handles, and modeling
variable and style creation in one in-memory catalog so naming conflicts
fail before any real resource exists. After that boundary, only resources
actually created for the current command are journaled and removed in
reverse order on failure.
**Why.** Removing dependent nodes before their styles, variables, and
collections keeps a failed render from leaving orphaned or half-wired
resources behind.
**What it means for you.**

- A materialized image has no removal API, so it becomes bounded
  `partial-residue` evidence rather than silently vanishing from the report.
- The four closed outcomes are `no-mutation`, `rolled-back`,
  `partial-residue`, and `completed`.

<!-- source: 0017 -->

### Return one bounded, versioned render Outcome

**Decision.** The plugin's response is untrusted post-dispatch input and
cannot reach an adapter until it passes a closed schema plus total byte,
nesting, and handle bounds. A completed Outcome contains only the created
root handle, executor version, planned and live structural facts, and
mutation facts; failure Outcomes never contain plugin stacks, JSX, image
bytes, or credentials.
**Why.** Unknown fields are protocol drift, not forward-compatible success,
and a malformed or oversized response must never be formatted as a
successful render.
**What it means for you.**

- `completed-with-findings` preserves the created root and maps to accepted
  code `1`; ordinary completion maps to `0`.
- CLI text, MCP structured content, JSON, YAML, and audit completion are all
  deterministic projections of this one value.

<!-- source: 0018 -->

### Treat auto-split and explicit batches as one Command

**Decision.** Wrapper auto-split and explicit `render-batch` both build the
same authoritative Command Plan, resolve the same target, and retain one
confirmation, deadline, audit lifecycle, and bounded Outcome. The request
owns a bounded ordered root set; component conversion, resize probing, and
verification are explicit stages rather than hidden adapter behavior.
**Why.** Two code paths for what is really one compound request would let
auto-split and an explicit batch silently diverge on confirmation,
targeting, or artifact handling.
**What it means for you.**

- `--keep-wrapper` deliberately selects the single-root path instead of
  splitting.
- A one-root `render --verify` uses this same compound Application rather
  than a separate post-render adapter.

<!-- source: 0019 -->

### Bound the foundation preflight with a hard deadline

**Decision.** The structured renderer bounds its combined foundation-catalog
preflight, which inventories local variable collections, variables, and
text styles, to 15 seconds inside the plugin runtime, before any canvas
mutation. A timeout returns a structured no-mutation failure and is never
retried.
**Why.** Without an internal deadline, one asynchronous read that never
settled in a large file could occupy the plugin's serialized execution chain
indefinitely while still looking connection-healthy.
**What it means for you.**

- A stalled catalog read fails one render; it cannot silently block later
  work on the same file.
- Component Property Facts use an independent read lane, so diagnosing a
  stuck render does not itself wait behind the stall.

<!-- source: 0120 -->

## Structural gate and reuse

### Mark live-only facts deferred, never resolved

**Decision.** Every offline structural check now reports `PASS`, `FAIL`, or
`DEFERRED`. A locally provable contradiction still fails the whole report,
but a fact that only a connected Figma document can settle, such as an
explicit variable reference, is marked deferred rather than claimed as
resolved or failed.
**Why.** The Structural Gate runs before plugin readiness, so treating a
live-only fact as offline evidence would let a report claim knowledge it
does not actually have.
**What it means for you.**

- An otherwise successful offline report is still visibly marked deferred
  when it contains a live-only fact.
- `render --prop-reference <element>` exposes the same closed per-element
  grammar used for validation without touching workspace, network, or
  plugin.

<!-- source: 0088 -->

### Require an approved plan before repeating structure

**Decision.** Every compound multi-root request derives a content-free reuse
plan before plugin readiness. Repeated raw frame structure is represented by
a stable truncated Finding ID with a bounded occurrence count; an unapproved
flat repetition stops before the first write with two actions: convert to a
component and use Instances, or approve that exact Finding ID.
**Why.** An advisory console warning was not acceptance evidence, so a
caller optimizing for root throughput could leave repeated raw trees with no
record of what was reused.
**What it means for you.**

- Unknown, stale, and wildcard approvals fail closed; an old approval cannot
  silently disable a later finding.
- The successful Outcome reports the reuse plan's component entities,
  instance count, and approved repetitions.

<!-- source: 0089 -->

### Generate render guidance from the same executable facts

**Decision.** A small Semantic Render Guidance Contract projects the closed
element/property grammar and native preflight facts directly into the MCP
Code-to-Figma workflow text. Every embedded example crosses the current
Command and Semantic Render Plan boundaries in CI.
**Why.** Maintaining a second hand-written description of supported JSX and
executor behavior would let documentation drift from what the renderer
actually accepts.
**What it means for you.**

- An Instance example authors only `entity` plus variant and override
  intent, never a raw component key or node id.
- Guidance names the exact `completed-with-findings` outcome and reason when
  an Image has no `src` and stays a placeholder.

<!-- source: 0090 -->

## Sizing, text and fonts

### Decide HUG versus FILL from measured CSS relationships

**Decision.** Browser DOM Capture decides sizing before creating the
Semantic Render Plan. An auto-sized container becomes HUG when it has
content, no fixed size, no growth, and no stretch relationship; full
cross-axis stretch becomes child FILL. A single-line text run becomes FILL
only at or above 75% of its container's inner width; below that it stays
HUG.
**Why.** Freezing an element to its measured pixels can overflow in Figma
because font metrics differ, and mapping every container to HUG stops copy
from wrapping responsively.
**What it means for you.**

- The browser's measured line count travels with the plan; a text fidelity
  probe reports font or line-count mismatches as findings, never silent
  fixes.
- Multiline, track-filling, and non-left-aligned runs keep FILL regardless
  of the ratio.

<!-- source: 0069 -->

### Keep Grid axes numeric until HUG is executable

**Decision.** The DOM adapter retains the measured numeric size for Grid
axes unless another supported relationship, such as parent cross-axis FILL,
is proven. Fixed Grid tracks and gaps stay native Grid properties. The
executor restores explicit numeric axes after the final append, before
applying FILL/HUG on nonnumeric axes.
**Why.** The current executor has no executable native HUG contract for a
Grid Frame, so encoding a measured Grid axis as HUG would fall back to a
fixed construction size and let children overflow.
**What it means for you.**

- A numeric Grid axis remains editable evidence rather than a flattened
  layout.
- Adding true Grid HUG later needs its own executable contract and
  resize-probe evidence; it is not silently assumed today.

<!-- source: 0072 -->

### Canonicalize font weight spellings before execution

**Decision.** JSX, browser capture, auto-split, and batch all converge on
one canonical numeric font-weight representation before the Structural Gate
and native executor preflight. `bold`, `"700"`, and `700` all become the
number `700`. FLOAT Variable references keep their `var:` identity; only a
literal fallback is canonicalized.
**Why.** Equivalent spellings selecting different execution paths would make
CLI and MCP projections diverge and let native support inspection run on
facts that are not what actually executes.
**What it means for you.**

- Context-dependent values such as `bolder`, unknown names, and
  out-of-range numbers stop at the plan boundary instead of guessing a
  mapping.
- The plan validator accepts only canonical weights, whichever adapter
  created the plan.

<!-- source: 0076 -->

## Images and design entities

### Preserve CSS object-fit with native Image structure

**Decision.** `fill`, centered `contain`, and centered `cover` map directly
to Figma's native FILL, FIT, and CROP Image paint modes. For `none`,
intrinsic `scale-down`, or non-centered placement, the Bridge instead
creates a clipped Frame with one absolute, aspect-correct native Image
child at the measured CSS box.
**Why.** Figma's direct Image paint modes cannot express every CSS
placement decision, and inventing an opaque crop-transform convention would
trade real Figma structure for something no one could edit natively.
**What it means for you.**

- Simple keyword, percentage, and pixel object positions are exact; complex
  CSS position expressions get a bounded fallback annotation instead of a
  silent fidelity claim.
- Visual verification and native-property readback are both required; a
  correct screenshot alone does not prove the paint and clip structure
  survived.

<!-- source: 0071 -->

### Fetch remote images on the host, never in the plugin

**Decision.** Remote image URLs in render input are source references, not
plugin capabilities. The host resolves every approved HTTP(S) image to
bounded, verified raster bytes before plugin readiness; the plugin itself
never receives a remote URL. Remote sources require an exact configured
origin, reauthorized on every redirect and DNS answer.
**Why.** Granting the plugin outbound network reach would widen its
authority far beyond the authenticated localhost bridge it is meant to stay
inside.
**What it means for you.**

- Accepted images become the same `embedded-raster` asset used for
  workspace images, carrying dimensions and a content hash.
- A guaranteed preview never fetches a remote source; it validates
  structure only.

<!-- source: 0077 -->

### Classify image references from one closed projection

**Decision.** `src` and `image` attributes accept literal quoted or braced
values only; they never evaluate JavaScript expressions. Literal workspace
image paths resolve through Workspace I/O; HTTP(S), `data:`, and `imgref:`
values remain separate explicit policy routes and are never reinterpreted as
workspace paths.
**Why.** Independent classification and replacement regexes scattered
across adapters would each need their own security review; one closed
parser needs it once.
**What it means for you.**

- Empty values, runtime expressions, missing files, and unsupported formats
  fail before plugin readiness, never mid-render.
- Adding a new supported image syntax means extending this one parser, not
  adding an adapter-specific path resolver.

<!-- source: 0078 -->

### Bind design entities once, before any mutation

**Decision.** During command preparation the host reads the Design Link
Registry once and projects only the entities a request actually uses into
an immutable Design Entity Binding Table. A local node id is executable
only when its registry file key exactly matches the command's target;
duplicate, missing, or stale links stop before any resource or canvas
mutation.
**Why.** Letting an executor consult a later registry revision, a fuzzy
name match, or the current selection to resolve identity would make the
same request bind to different components on different runs.
**What it means for you.**

- Published component or variant keys are preferred over local node ids
  wherever both exist.
- A screen or frame root cannot be converted to a component in the same
  request, because that would change its declared entity kind after
  binding.

<!-- source: 0079 -->

### Make generated resource creation an explicit opt-in

**Decision.** For implicit spacing, radius, and typography candidates, the
default is exact reuse of an existing compatible variable or text style, or
literal preservation; nothing new is created unless `materializeResources`
(MCP) or `--materialize-resources` (CLI) is set. Explicit `var:` references
and named text styles keep their existing resource semantics regardless.
**Why.** Creating every missing inferred resource by default would silently
expand a file's design system, and could produce a parallel resource when a
literal was intentionally local to one screen.
**What it means for you.**

- A payload-free Command Preview states whether generated creation is
  enabled for that request.
- Bounded reports distinguish references, reuse, creation, binding, and
  literal preservation as separate outcomes.

<!-- source: 0111 -->

## Verification and motion

### Wait for the render to actually stabilize before export

**Decision.** Coupled render verification, immediately after native
mutation and placement, first observes two consecutive stable geometry
samples, then makes up to five same-node PNG exports at bounded 50ms
intervals and keeps the largest candidate. Standalone `verify` remains one
export with no delay.
**Why.** Figma can report final node geometry while its export raster still
shows only the root background, so a same-size valid PNG right after
mutation is not sufficient evidence the render is visually ready.
**What it means for you.**

- Byte length is only used to pick among transient exports of one node, not
  as a visual-fidelity score.
- Repeated export never repeats the Figma mutation or changes the returned
  node handle.

<!-- source: 0073 -->

### Round-trip motion between CSS animations and Figma

**Decision.** Motion Capture records a node's native keyframe tracks as a
bounded fact; `motionToCss` turns it into `@keyframes` plus an `animation`
declaration, shifting each easing one keyframe back to match CSS's
convention. Browser DOM Capture reads computed animation facts, pauses
playback to capture resting geometry, and `cssAnimationToMotion` synthesizes
the return trip.
**Why.** Figma stores easing on the keyframe it arrives at while CSS
applies it to the segment leaving a keyframe, so a literal field copy in
either direction would silently desync the animation.
**What it means for you.**

- Every layer on a frame shares that frame's timeline; a shorter endless
  loop repeats to fill it, and anything else keeps its own length.
- Springs, Variable-bound easings, and fields without a CSS equivalent
  become explicit limitations with a neutral fallback, never an invented
  approximation.

<!-- source: 0129 -->
