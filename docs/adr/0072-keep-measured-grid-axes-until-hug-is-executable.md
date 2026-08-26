# Keep measured Grid axes until HUG is executable

Browser rectangles are rendered-viewport evidence, while CSS auto sizing is
source intent. The Bridge may normally express intrinsic Flex and flow axes as
Figma HUG, but the current Semantic Render executor has no executable native
HUG contract for a Grid Frame. Encoding a measured Grid axis as `hug` therefore
falls back to the executor's 200px construction size and lets children overflow
an incorrectly sized parent.

The DOM adapter retains the measured numeric size for Grid axes unless another
supported relationship, such as parent cross-axis FILL, is proven. Fixed Grid
tracks and gaps remain native Grid properties, so the numeric outer size is
editable evidence rather than a flattened layout.

Figma may also reset a fresh Grid's dimensions when `layoutMode` is initialized
or when the Grid enters an Auto Layout parent. The executor restores explicit
numeric axes after the final append and only then applies FILL/HUG relationships
on nonnumeric axes. Regression tests simulate both native resets.

Adding true Grid HUG later requires a new executable contract, real Figma
readback and resize probes. Until then the Bridge must not serialize an intent
that the Plugin cannot honor.
