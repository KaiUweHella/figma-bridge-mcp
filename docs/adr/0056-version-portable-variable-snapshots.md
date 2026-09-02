# Version Portable Variable Snapshots

Generated DESIGN.md files carry a `variableSnapshot` contract with
`schemaVersion: 2` and `kind: figma-variable-snapshot`. Collections, modes and
Variables are arrays because Figma permits duplicate display names. Stable
handles inside one snapshot identify each entity; mode values and local Alias
targets reference those handles rather than array position or a first matching
name.

The capture keeps the Collection's declared default mode, publishing
visibility and optional source publish key. Every Variable keeps all six
official types, description, publishing visibility, scopes, code syntax and
its authored values. Exact values stay keyed by mode handle. Same- and
cross-Collection Aliases resolve to a Collection and Variable handle;
unavailable external targets remain explicit unresolved Alias facts instead of
being guessed or silently flattened.

Figma-authored color Alias opacity is captured as the native closed
`COMPOSE_COLOR(alias, opacityPercent)` value and normalized into the existing
Alias identity fact with an optional bounded `opacity` percentage. This keeps
the target edge and authored modifier together without treating arbitrary
Variable expressions as valid. The current public Plugin setter rejects
composed color values, so exact import refuses a snapshot containing Alias
opacity before Plugin readiness. Export evidence remains complete; import does
not flatten the value to RGBA or discard its Alias identity.

Chunked extraction records the expected Collection membership. Every catalog
and value read is pinned to one daemon-attested connection, file and document
revision; connection or revision drift aborts publication. A failed catalog
read is an extraction error, never evidence for an empty Variable system. If a
value chunk is dropped after bounded retries, the snapshot declares
`complete: false`; a future exact importer must reject it before Plugin
readiness. Source native ids and publish keys are provenance only and must not
select mutation targets in a different Figma file.

The source contract is closed before projection: foreign mode keys, open Alias
objects, incompatible values and local Alias cycles are rejected. Both the v2
contract and the final generated DESIGN.md must fit the Workspace reader's byte,
depth and collection-entry budgets, so export cannot produce an artifact that
the supported importer refuses to parse.

EASING values use Figma's native canonical readback shape, not setter
shorthand. Cubic families carry `easingFunctionCubicBezier`, spring families
carry `easingFunctionSpring`, and `HOLD` carries neither. Named presets must
match Figma's native preset-specific curve or bounce; only `CUSTOM_*` values
remain freely authored inside their numeric bounds. EASING and TIMING scopes
must be the native `ALL_SCOPES` form because their Plugin API scope setter is
not available. These constraints keep a capture → import → capture comparison
exact even though Figma expands or normalizes setter inputs during readback.

Count and source-shape limits apply to the lightweight Collection catalog before
the first value chunk. Every chunk is closed, typed and measured before it is
retained, and cumulative raw bytes and graph entries are checked before
aggregation. Limits are therefore execution budgets, not only late parser
validation.

The former name-keyed `variables` block remains beside v2 during migration so
older readers retain their bounded merge utility. It is not exact: duplicate
Variable names, duplicate mode names, default mode, metadata and Alias identity
can be lost. The owned importer always prefers and fully validates v2; only v1
is allowed to reach the legacy compatibility Adapter.

Exact import accepts only `complete: true` snapshots with resolvable local
Aliases. It also rejects a non-first declared default mode before Plugin
readiness because the current Plugin API exposes no operation to change which
mode a newly created Collection considers default. Rejecting that topology is
more truthful than silently reordering or relabeling its authored modes.

The generated exact-import program must also fit both authenticated 5 MiB
transport envelopes after JSON escaping: the HTTP `/exec` body and the daemon
→ Plugin message. Those final encoded sizes are checked during source
preflight, before Plugin readiness, even though the portable storage contract
has a larger Workspace ceiling. Oversized snapshots remain valid evidence but
require a future typed or chunked mutation transport before they can be
restored.
