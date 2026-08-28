# Own Component Add Variant as a rollback-safe Command Application

## Status

Accepted.

## Context

`component add-variant` extends an existing local Component Set. Its useful
behavior includes choosing the nearest Variant or an explicit `--from` source,
backfilling a newly introduced axis across existing Variants, cloning the
source and placing the new Variant beside its siblings.

The legacy Commander handler parsed and resolved the request, generated an
unbounded Plugin eval and formatted the result itself. A failure after sibling
renames or cloning could leave a partial Component Set. CLI and MCP also did
not consume one authoritative implementation. In a free-layout Component Set,
the legacy placement could move a new Variant beyond the Set bounds while
`clipsContent` hid it.

## Decision

One closed request now canonicalizes typed Component Set references, Variant
pairs, `--from` and output mode before Plugin readiness. It bounds names,
values, axis count and controls without removing the supported clone-nearest,
explicit-source or new-axis workflows.

CLI and MCP execute the same `component.add-variant` Command Plan and Command
Application with compatibility fallback disabled and retry set to `never`.
The Plugin phase bounds Component Set discovery, rejects ambiguous or duplicate
targets before mutation and returns those refusals as a typed `no-mutation`
result.

The mutation journals every sibling rename, the cloned Component and any
free-layout Component Set expansion. A fresh read verifies exact membership,
names, parentage, source selection and visible Set bounds. Failure removes the
clone, restores sibling names and restores Set geometry, then reports verified
rollback or bounded residue. Host validation rejects malformed Plugin results.

## Consequences

Adding a Variant remains equally capable from either Adapter, including
multi-axis requests and deliberate new axes. Manual approval is requested once
for the complete write rather than for internal steps. Duplicate requests are
precise no-op failures, partial failures are not retried, and a newly positioned
Variant cannot remain clipped outside a free-layout Component Set.

The old generated mutation helper is removed; only the pure pair parser,
Variant-name parser and nearest-source selector remain shared helpers.
