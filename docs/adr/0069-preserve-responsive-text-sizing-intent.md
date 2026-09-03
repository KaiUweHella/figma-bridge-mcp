# Preserve responsive text sizing intent

Browser rectangles are evidence of one rendered viewport, not sufficient
sizing intent. Freezing an intrinsically sized element to its measured pixels
can make a native Figma Text child overflow because browser and Figma font
metrics differ. Conversely, mapping every text container to HUG prevents copy
from following a narrower parent and wrapping responsively.

The Browser DOM Capture adapter therefore decides sizing before creating the
Semantic Render Plan. An in-flow auto-sized container becomes HUG on an axis
when it has content, no authored fixed size, no growth, no Grid allocation and
no parent stretch relationship. Authored fixed dimensions remain fixed.
Available-width relationships such as full cross-axis stretch become child
FILL sizing. Numeric min/max constraints are retained where Figma can express
them.

Direct Text uses FILL when it occupies the available track, is multiline,
must retain non-left alignment inside a bounded container, or can wrap inside
a responsive FILL container. Its source horizontal alignment is assigned to
the native Text property. Intrinsic single-line Text inside a HUG container
remains HUG.

Computed `white-space`, `overflow-wrap`, `word-break` and `hyphens` are part of
Browser DOM Capture evidence. Figma Auto Layout has no container-side
`STRETCH` alignment enum, so CSS stretch is represented only by FILL children;
emitting an invented container enum is an execution failure, not a fallback.

Resize probes and screenshot verification remain required because browser and
Figma line breaking can still differ even when the responsive relationship is
preserved.

## Amendment 2026-09-03: the measured run width decides, and the render is measured back

"Can wrap inside a responsive FILL container" made every single-line run in a
FILL container FILL, however short it was. A label occupying a fifth of its
track has visible room; making it FILL bought no responsiveness and produced
oversized text boxes. The Browser DOM Capture now compares the run's own width
(the `Range` rectangle) with the container's inner width. Below
`TEXT_HUG_BELOW_TRACK_RATIO` (0.75) a single-line run is HUG; at or above it
the copy is track-bound and stays FILL. Runs that fill the track, multiline
runs and non-left alignment keep their FILL as before. The threshold is a
judgement, not a measurement, and is calibrated against the Northern fixture,
which carries both widths for every run.

No rule can know whether Figma's font metrics wrap a run the browser set on
one line: the Northern headline occupied 93 % of its track, stayed one line in
the browser, and wrapped in Figma. So the browser's measured line count now
travels with the plan (`lines` on each text) and the render is measured back.
The text fidelity probe reads every rendered TEXT node through the semantic
path the executor stamps on it and reports, as findings, a font family or
style that differs from the requested one (the native executor falls back to
Inter when a family is not installed and used to say nothing) and a line count
that differs from the browser's. It never corrects anything; the finding is
the deliverable. The compound Application runs it as the `text-fidelity`
stage whenever a `textFidelityProbe` adapter is supplied, and the `render`
command runs it after every native render.
