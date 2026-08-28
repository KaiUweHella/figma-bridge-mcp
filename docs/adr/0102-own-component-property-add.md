# Own Component Property Add as a rollback-safe Command Application

## Status

Accepted.

## Context

`component prop add` creates reusable `TEXT`, `BOOLEAN`, and `INSTANCE_SWAP`
definitions on local Components and Component Sets. The legacy Commander Action
owned type normalization, Boolean coercion, Plugin readiness, generated
mutation code, and output. It did not freshly verify the definition or remove
an attributable new property if a later step failed.

Native `VARIANT` properties are not an independent creation primitive. Figma
derives them when named Components are combined as Variants. The old command
already refused direct Variant creation and printed a multi-step workaround.
Its `--options` flag remained accepted but could not affect the three real
property types.

## Decision

One closed request owns Component/URL targeting, property name, type, literal
default, legacy option spellings, and output mode. Invalid types and direct
Variant creation stop before readiness or confirmation with guidance to create
and combine named Components. `--options` remains accepted for compatibility
and produces an explicit warning instead of silently pretending to configure a
non-Variant definition.

CLI and MCP execute the same authentic `component.prop.add` Command Plan and
Command Application with compatibility fallback disabled and retry set to
`never`. The Application preserves the legacy Boolean rule (`true` and `1` are
true; every other string is false), plain Text defaults, and direct Instance
Swap strings. A Component Set node id supplied as an Instance Swap default is
resolved to its native default Component.

Before mutation, the Plugin snapshots existing definition membership. Fresh
readback proves that every original definition remains and that the returned
property has the requested name prefix, type, and normalized default. On a
setter or postcondition failure, rollback deletes only a uniquely attributable
new definition. A fresh second read distinguishes complete rollback, bounded
residue, and unavailable verification. Host validation rejects malformed or
semantically mismatched Plugin results.

## Consequences

Agents retain the complete useful property-creation surface without hidden
Boolean or option changes, and both Adapters approve one semantic operation.
Successful creation carries exact definition evidence. Partial failures are
never retried, and rollback cannot delete an unrelated concurrently created
property merely because it appeared after the snapshot.

Property setting remains owned by its separate rollback Application. Property
deletion remains a later irreversible slice because recreating a deleted
definition cannot preserve Figma's generated property identity.
