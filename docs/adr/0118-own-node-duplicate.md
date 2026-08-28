# ADR 0118: Own Node Duplicate as a rollback-verified Command Application

## Status

Accepted.

## Context

`node duplicate` is a core Code-to-Figma operation. Its Commander Action
previously resolved nodes, called `clone()`, optionally moved and renamed the
copy, applied offsets and formatted output itself. If a later step failed, the
process Adapter could not preserve whether the copy was removed, remained in a
parent, or changed child order. MCP and CLI also did not share one decreasing
deadline or one semantic result.

Removing options would reduce product utility. Retrying after an uncertain
`clone()` would risk an additional copy.

## Decision

Parse source and optional parent references, index, name, signed offsets and
JSON output through one closed Node Duplicate Request. URL references from both
nodes must identify one Figma file before confirmation or readiness.

CLI and MCP dispatch one `node.duplicate` Command Plan through the same
non-retrying Application. It preflights source and target membership before the
only `clone()`, retains the existing same-parent 40 px default and every
explicit placement option, then freshly verifies type, name, coordinates and
complete affected-parent order.

Free-layout and absolutely positioned copies verify the requested offsets
exactly. When a Row, Column or Grid Auto Layout parent manages the child's
position, duplication remains successful and reports `auto-layout-managed`
with Figma's fresh coordinates instead of treating expected layout behavior as
a failed write.

The new copy is the Application's only rollback-owned resource. A failed
postcondition removes it and verifies both parents. Failure exposes a bounded
`rolled-back`, `partial-residue` or `verification-unavailable` mutation report;
an oversized or malformed Plugin result never becomes success or authorizes a
retry.

## Consequences

- Normal and advanced duplicate workflows retain their behavior.
- Auto Layout/Grid duplication remains available without a false offset
  failure.
- Invalid requests make no Figma mutation.
- CLI, MCP and Audit receive the same deadline and structured outcome.
- The mechanically pinned direct Node-write inventory decreases from 12 to 11.
- Broader STAB-06 migration remains incremental and does not block this slice.
