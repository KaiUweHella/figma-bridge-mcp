# ADR 0124: Own Size Variants as a rollback-verified Command Application

## Status

Accepted.

## Context

`sizes` is a public three-node Figma write, but its Commander Action previously
owned readiness, generated evaluation, mutation and result formatting. The MCP
Adapter re-entered that Action. A failure after one or more clones therefore
lost which Components remained, whether selection changed, and whether cleanup
had succeeded. A FRAME source also created an extra temporary Component before
the three requested variants and never reported or removed it.

Repeating an uncertain `clone()` would risk duplicate Components. Removing
FRAME, INSTANCE, signed-gap or base-size behavior would reduce existing utility.

## Decision

Parse the optional Component, Instance or Frame reference, base size and signed
gap through one closed Size Variants Request. Preserve the established Small,
Medium and Large multipliers, the default medium base, the default 40 px gap,
and legacy zero-gap normalization. Only the typed node field may contribute a
Figma URL target, independent of option order.

CLI and `figma_run` dispatch one non-retrying `sizes` Command Plan through the
same Application with compatibility fallback disabled. Before writing, the
Application bounds source/page membership, hierarchy, geometry, names, fonts
and every scaled dimension, then loads the exact observed fonts. It owns only
the three clones, converts each FRAME clone directly, and never creates a
temporary source Component.

Success requires fresh source, parent, page, order, type, name, dimensions and
placement verification. Selection and viewport updates occur only after the
document result is proven and remain bounded warnings if the editor refuses
them. A failed postcondition removes every attributable clone, restores the
prior selection and freshly reports `rolled-back`, `partial-residue`, or
`verification-unavailable`. Malformed or oversized Plugin results cannot become
success or authorize retry.

## Consequences

- Component, Instance and Frame workflows retain the same three size outputs.
- FRAME input no longer leaves a fourth, unrequested Component.
- CLI, MCP and Audit share one target, deadline and mutation outcome.
- Invalid requests and failed preflight produce a proven no-mutation report.
- The mechanically pinned direct Size Variants inventory decreases from one to
  zero while the broader STAB-06/STAB-26 migration remains incremental.
