# Own Node-to-Component Conversion as an irreversible Command Application

`node to-component` previously executed a direct Commander-owned loop. It
silently skipped missing or unsupported targets, used a separate connection
wait and `fastEval` timeout, and returned only the Components produced before
an error. MCP therefore could lose whether an earlier target had already been
converted and could not carry bounded irreversible residue into Audit.

Keep the complete public batch conversion behavior for Frames and Groups, but
move it behind one closed `node.to-component` request and one authentic,
non-retrying Command Application shared by Commander and `figma_run`.
Node References, duplicate and cross-file checks close before confirmation or
readiness. The Plugin resolves every target, parent membership, child order and
bounded ancestry before the first native conversion; nested target batches are
refused because no ordering can preserve the requested independent conversions.

Conversion remains sequential because Figma exposes only
`createComponentFromNode()`, not an atomic batch or an identity-preserving
inverse. After each native call, fresh parent membership, Component type, name,
index and child identity must match the pre-conversion facts. A thrown native
acknowledgement is accepted only when that complete desired state is proven.
A later failure reports every proven Component as bounded `scene-node`
residue; unverifiable current targets remain possible residue. No result path
retries or pretends that an irreversible Component can be restored to the
original Frame or Group.

The response is a bounded, versioned JSON value inside the Plugin seam and a
compact Adapter projection outside it. This prevents a successful mutation
from being reclassified as a generic transport timeout merely because its
post-write result was unbounded.
