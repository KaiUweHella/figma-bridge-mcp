# Own Component Property wiring and nested exposure

## Status

Accepted.

## Context

Figma distinguishes a Component property definition from the sublayer field
that it controls. The Bridge could create TEXT, BOOLEAN and INSTANCE_SWAP
definitions, but it could not apply their `characters`, `visible` or
`mainComponent` references. Agents could therefore report a finished property
after creating an inert definition. The existing property read also omitted
preferred values, Slot settings, definition-to-layer references and nested
Instance exposure, so it could not diagnose that mistake.

Figma additionally lets a wrapper Component expose the properties of one of
its primary nested Instances. The Bridge could instantiate and swap nested
Components, but had no closed operation for `isExposedInstance`; arbitrary
eval was the only route. INSTANCE_SWAP preferred values were likewise visible
in native metadata but unavailable during property creation.

## Decision

`component prop bind` is one closed, rollback-owned Command Application. It
resolves an exact or unambiguous property name, infers the only compatible
native field from the definition type and requires the target to be a real
descendant of the Component or Component Set. Existing bindings are preserved;
replacement needs `--replace`, and `--remove` only removes the named property.
Fresh readback verifies the complete reference map and rollback restores that
map after a failed setter or postcondition.

`component nested expose` is a separate closed Command Application for one
primary nested Instance. It refuses inherited Instances below another
Instance, performs one Boolean mutation and verifies or restores the prior
state without retrying.

Component Property Facts advance to schema version 2 and use the typed read
lane rather than serialized arbitrary eval. The bounded read walks only the
explicit Component subtree and returns every native property type,
Variant options, preferred values, Slot description/settings, scalar bindings,
binding status, nested Instance exposure, Slot child counts and native limit
violations. Unknown references or oversized subtrees fail instead of becoming
plausible partial facts. Because the read bypasses the mutation lane, it remains
available to reconcile an unknown prior write. Figma omits `defaultValue` from
real SLOT definitions, so the projection normalizes that one native absence to
`null` while retaining strict scalar defaults.

`component add-variant --from` snapshots the source Variant's bounded
definition-owned descendant paths before cloning. After Figma's native clone,
it restores TEXT, BOOLEAN, INSTANCE_SWAP and SLOT references plus nested
Instance exposure by structural path and includes those facts in its fresh
postcondition. A mismatch rolls the clone and any axis backfill back instead of
returning a structurally valid but inert Variant.

`component prop add --preferred` resolves bounded file-local Component or
Component Set ids to native preferred-value keys before creating an
INSTANCE_SWAP definition. The agent-facing `figma_reference {name:"components"}`
guide derives its executable recipes from these closed commands and documents
all five Figma property types, nested exposure, Slots and validation rules.

## Consequences

Agents can now build a functional Component contract rather than a list of
unwired definitions. Property inspection makes unbound scalar controls a
visible defect, wrapper exposure becomes auditable, and preferred Instance
choices can be authored without raw Plugin code. VARIANT and SLOT remain
native, separate workflows: Variants come from named Component combinations,
while Slots use the dedicated Slot commands and structural child operations.
Slot minimum violations are authoritative on exercised Instances; Figma can
report no violation for an empty Slot on the main Component itself.
