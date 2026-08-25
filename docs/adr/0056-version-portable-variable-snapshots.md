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

Count and source-shape limits apply to the lightweight Collection catalog before
the first value chunk. Every chunk is closed, typed and measured before it is
retained, and cumulative raw bytes and graph entries are checked before
aggregation. Limits are therefore execution budgets, not only late parser
validation.

The former name-keyed `variables` block remains beside v2 during migration so
older readers retain their bounded merge utility. It is not exact: duplicate
Variable names, duplicate mode names, default mode, metadata and Alias identity
can be lost. New import work must prefer and fully validate v2 rather than
quietly treating legacy data as the portable contract.
