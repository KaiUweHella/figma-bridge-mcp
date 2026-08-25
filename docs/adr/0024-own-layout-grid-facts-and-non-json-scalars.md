# Own Layout Grid Facts and non-JSON scalars

`grid list` owns one closed Layout Grid Facts Command Application shared by
Commander and MCP. Its request accepts an optional semantic Node Reference and
text or exact JSON projection regardless of option order. A missing node means
the current selection; a Figma URL in the node field may derive file targeting,
while unrelated values cannot.

The versioned result preserves node id, name and type, `gridStyleId`, every
authored ROWS, COLUMNS or GRID property, RGBA values and per-field Variable
Aliases. Both Plugin and host enforce grid, value, depth, container, key,
string and total serialized-size limits. Unknown union fields, malformed
aliases and unsupported node kinds fail instead of becoming plausible facts.

Figma defines `RowsColsLayoutGrid.count === Infinity` as Auto. Plain JSON turns
that valid runtime value into `null`, so the Bridge encodes it before the JSON
seam as `{"$figmaScalar":"Infinity"}`. Style Facts and Layout Grid Facts share
one closed scalar vocabulary and one exact LayoutGrid host contract. The tag is
valid only at ROWS/COLUMNS `count`; all other non-finite numbers fail on both
sides of the Plugin seam.

This scalar vocabulary is deliberately not a generic JavaScript serializer.
The pinned Figma Plugin API currently exposes no other authored non-JSON scalar
that these exact projections need. `figma.mixed` and binary byte arrays remain
owned by their existing explicit projections. Any new scalar requires a
versioned contract decision and compatibility tests before it can cross the
Bridge.

Layout Grid mutation, Style Catalog scans, Style Consumer discovery and full
Design Capture remain separate Applications with different effect and fanout
contracts.
