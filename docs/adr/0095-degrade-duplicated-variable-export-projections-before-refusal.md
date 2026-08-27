# Degrade Duplicated Variable Export Projections Before Refusal

## Status

Accepted.

## Context

Portable Variable Snapshot extraction must never publish a DESIGN.md that its
own Workspace-bounded importer rejects. A normal document may nevertheless
cross that boundary even while exact v2 fits, because long STRING values are
repeated in the human Variable table and the name-keyed legacy v1 block.
Refusing the complete extraction preserves safety but unnecessarily loses a
useful and round-trippable exact snapshot.

Structure splitting is a separate concern. `--no-split` means that the caller
wants Structure kept in the main document; it is not permission to raise the
8 MiB text/JSON or 100,000-entry Workspace authority.

## Decision

Render the existing document first. If and only if that normal projection
exceeds the closed Workspace byte or graph budget and a Machine-readable tokens
section contains a Variable Snapshot, render one deterministic fallback:

- keep Portable Variable Snapshot v2 complete and unchanged;
- omit the migration-only name-keyed v1 `variables` block;
- shorten only human-readable Variable table cells to a bounded preview;
- describe the degradation in visible Markdown and machine-readable metadata;
- validate the fallback again with the same or stricter Workspace limits.

Caller-supplied limits may narrow the default authority for a stricter host or
boundary test, but are clamped so they can never raise it. If exact v2 or the
remaining document still exceeds the authority, extraction continues to fail
closed. A document without the canonical tokens section is never made lossy to
force it through the limit.

## Consequences

Normal DESIGN.md output retains its previous bytes, including legacy v1.
Large Variable systems remain exactly re-importable when duplication, rather
than the canonical snapshot, caused the overflow. Older readers lose their v1
compatibility view only on an export they could not have safely consumed as a
whole, and that omission is explicit. Hard Workspace limits and exact v2
validation remain the final authority.
