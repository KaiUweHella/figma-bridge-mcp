# Own Component Instantiate as a rollback-safe Command Application

## Status

Accepted.

## Context

`component instantiate` creates an Instance from one explicit Component and
optionally reparents, positions, inserts and renames it. Its direct Commander
Action performed those writes without sharing request validation, execution,
postconditions or partial-failure semantics with MCP.

Library Components are a normal design-system source and must remain usable.
Restricting the command to local Components would reduce the useful workflow
without improving the safety of the destination write.

## Decision

Use one closed request and one authentic, non-retrying
`component.instantiate` Command Plan from CLI and MCP. Preserve exact Component
or URL targeting, library/remote sources, default-current-page placement,
explicit writable parents, signed coordinates, optional child index, optional
layer name and JSON output.

The Application preflights the source, destination membership, insertion
index and non-recursive hierarchy before one native `createInstance` call. It
freshly verifies source identity, parent, child order, index, coordinates and
name. Failure after creation removes only the exact returned Instance and
checks both its absence and the original destination order. Unprovable cleanup
is reported as partial residue or unavailable verification and is never
retried.

## Consequences

Equivalent CLI and MCP requests now share one target, confirmation, deadline,
mutation and output contract. Normal Component-to-Instance composition remains
fully available, including remote library sources. The response is bounded and
distinguishes preflight refusal, verified rollback, exact residue and uncertain
verification instead of treating every Plugin error as safely repeatable.
