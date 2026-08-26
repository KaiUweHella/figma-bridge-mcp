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
