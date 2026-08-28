# Own Component Property Delete as an irreversible Command Application

## Status

Accepted.

## Context

`component prop delete` removes one exact Component or Component Set property,
but its legacy Commander Action owns readiness and generated mutation code. It
does not prove the definition exists before dispatch or verify its absence
afterwards. Figma assigns the full `#suffix` identity and offers no API that can
recreate a deleted property with that identity, so rollback is impossible.

## Decision

Use one closed request for the Component/URL target, exact full property name
and output mode. CLI and MCP consume the same authentic, non-retrying
`component.prop.delete` Command Plan and Command Application. The operation
keeps the existing exact-name behavior and does not block deletion based on
property type, layer references or downstream Instances.

Before dispatch, the Application proves a local Component or Component Set,
bounded definition membership, exact target membership and bounded typed
metadata. After the one native delete call, fresh readback must prove the
target absent and every other original definition still present. If the native
call throws but readback proves that exact desired state, the operation reports
verified success with a warning. Otherwise it distinguishes unchanged,
irreversible partial residue and unavailable verification without retrying or
claiming rollback.

## Consequences

Property deletion remains fully available to agents and users, now with one
approval and exact outcome evidence across both Adapters. Missing, remote and
malformed targets stop before mutation. Once deletion is proven, no code path
pretends the generated property identity can be restored; recovery requires an
explicit new create operation with a new identity.
