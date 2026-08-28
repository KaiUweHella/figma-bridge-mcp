# Own Component Property Set as a rollback-safe Command Application

## Status

Accepted.

## Context

`component prop set` is the focused edit path for changing `TEXT`, `BOOLEAN`,
`VARIANT`, and `INSTANCE_SWAP` values on one Component instance. Its useful
legacy behavior includes resolving an unambiguous property base name without
the generated `#…` suffix, parsing Boolean spellings, and resolving a local
Component Set reference to its default Variant for Instance Swap.

The legacy Commander Action owned request parsing, generated Plugin code,
mutation, result interpretation, and output. MCP therefore had to re-enter
Commander. A setter or postcondition failure had no fresh readback, rollback,
or typed residue, while malformed argument shapes could reach readiness and
manual confirmation before failing.

## Decision

One closed request owns the instance reference, property name, literal value,
and output mode. It preserves Figma URLs for target selection, canonicalizes
the node id for execution, treats empty and option-looking values as payload,
and bounds the request and response below the Plugin transport ceiling.

CLI and MCP execute the same authentic `component.prop.set` Command Plan and
Command Application with compatibility fallback disabled and retry set to
`never`. Plugin preflight preserves exact-name priority, unambiguous suffix
resolution, all four supported value types, Boolean aliases, direct Instance
Swap strings, and Component/Component Set node-id resolution. Unsupported Slot
mutation is refused before dispatch because Figma's API explicitly cannot set
Slot properties on an instance.

The Application captures the exact prior scalar, skips a redundant same-value
write, performs one requested mutation, and freshly reads the instance back.
Any setter or postcondition failure restores the prior scalar, verifies that
rollback independently, and returns bounded `rolled-back`, `partial-residue`,
or `verification-unavailable` evidence. Preflight failures carry an explicit
`no-mutation` report, and the host rejects malformed Plugin results.

## Consequences

Agents and users retain the complete useful property-editing surface from both
Adapters. Manual mode approves the semantic operation once rather than an
internal sequence. A successful response proves the fresh Figma value, a
same-value request is efficient without becoming an error, and an uncertain
write is never automatically retried.

The old generated mutation eval is removed from Commander. Property creation,
listing, and deletion remain separate legacy slices until their own behavior
can be migrated without coupling or feature loss.
