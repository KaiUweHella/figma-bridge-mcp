# Stabilize coupled Render verification at the export boundary

Standalone screenshots read an already existing Figma node. Coupled Render
verification is different: it calls `exportAsync` immediately after native
mutation, placement and optional follow-up stages. Figma can report final node
and child geometry while its export raster still contains only the root
background. A same-size valid PNG is therefore not sufficient evidence that a
fresh render is visually ready.

Only the coupled single and compound Render verification stages wait. They
first observe two consecutive stable, bounded geometry samples. They then make
at most five same-node PNG exports at the same dimensions and scale, separated
by bounded 50ms intervals, and retain the largest candidate. Byte length is not
a visual-fidelity score; it selects among transient exports of one exact node
where the blank root-only raster is materially smaller than the completed
render. The loop stops after a repeated best size and is bounded even when no
candidate stabilizes.

Standalone `verify` remains one export with no delay. It is a read after the
caller-selected node already exists and should not pay mutation-settle cost.

The coupled result continues through the existing bounded PNG decoder and
Plan-owned artifact writer. Repeated export never repeats the Figma mutation,
widens Plugin authority or changes the returned node handle.
