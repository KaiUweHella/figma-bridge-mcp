# Own Component Create as a rollback-safe Command Application

## Status

Accepted.

## Context

`component create` creates a new local Component and optionally controls its
name, dimensions, position, parent and child index. Its direct Commander
Action performed that mutation without sharing request validation, execution,
postconditions or partial-failure semantics with MCP. The documented `-h`
height option also collided with generic help detection in the Figma Command
Grammar and could therefore be classified as a no-effect help request.

Parent placement, including an explicit index on the current Page, is useful
for precise Code-to-Figma composition and must not be removed to simplify the
mutation contract.

## Decision

Use one closed request and one authentic, non-retrying `component.create`
Command Plan from CLI and MCP. Preserve the default name and geometry,
arbitrary bounded names, positive dimensions, signed local coordinates,
default-current-page placement, explicit writable parents, explicit child
indices and JSON output.

Treat `-h` as the documented height option for this action while retaining
`--help` as the unambiguous help form. The Application preflights native
creation availability, destination membership and the insertion index before
one native factory call. It freshly verifies local Component identity, exact
parent order, index, name, dimensions and coordinates. Failure after creation
removes only the exact returned Component and verifies both its absence and
the original destination order. Unprovable cleanup is reported as partial
residue or unavailable verification and is never retried.

## Consequences

Equivalent CLI and MCP requests now share one target, confirmation, deadline,
mutation and output contract. Exact Code-to-Figma placement remains available,
including insertion into the current Page. A short option that means height
can no longer silently bypass write policy as help. The response is bounded
and distinguishes preflight refusal, verified rollback, exact residue and
uncertain verification.
