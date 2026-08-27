# Create Variables with final compatible metadata

Variable Creation and Variable Batch Creation accept optional final
description, publishing visibility and scope intent in the same closed request
as identity, type and initial value. Omission is distinct from an empty or
false value and leaves Figma's native field default unchanged. Batch items own
their metadata independently, and false, zero and empty-string mode values
remain explicit writes.

One host-side scope-set policy is shared by create, create-batch, update and
update-batch request preparation. It rejects unknown and duplicate scopes,
permits an empty set, requires `ALL_SCOPES` to be the sole member when present,
and checks narrow scopes against the resolved Variable type. Update
Applications repeat the type check against the freshly resolved target before
the first mutation.

Creation journals each native identity immediately after the factory returns,
before assigning either values or metadata. Fresh readback must match every
requested field and expose a valid type-compatible native scope set. An ignored
setter, incompatible readback or later projection failure removes the single
Variable or the complete batch journal and verifies cleanup. Adapters therefore
need neither a second confirmed update nor weaker success semantics.
