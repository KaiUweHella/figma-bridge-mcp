# ADR 0125: Own Component Combinations as a bounded rollback-safe Application

## Status

Accepted.

## Context

`combos` analyzed a Component Set in one Plugin eval, expanded its Cartesian
property product without a bound on the host, then performed labels, Instances,
detachments and Component conversions in a second eval. A failed property
assignment was silently skipped, so a partial grid could be reported as
success. Neither Adapter retained ownership or rollback evidence.

## Decision

One closed request owns the optional Component Set, Variant or Instance
reference, signed gap, label/Boolean inclusion and dry-run mode. Only the typed
node may derive Figma URL identity. Property count, option count, combinations,
children, names, geometry and results are bounded before mutation.

CLI and `figma_run` execute one non-retrying `combos` Command Plan and Command
Application with compatibility fallback disabled. Dry-run returns the same
bounded analysis without creating nodes and is planned as a safe read. A write
preloads label fonts, owns
every label and every Instance/detached/converted identity, creates every
combination or fails the whole operation, freshly verifies each requested
Instance property before detaching it, and then verifies page membership,
names, types and placement. Failure removes all attributable nodes, restores
selection and reports rollback, bounded residue or unavailable verification.

The hard ceiling of 256 is a safety bound for this explicitly requested legacy
materialization workflow, not a recommendation to create large Component Sets.
`combos` creates standalone derived Components through Instance → detach →
conversion; it neither extends the source Component Set nor preserves Instance
identity. Use `component add-variant` when the intent is to extend the Set, and
keep ordinary authored Component Sets below the component-authoring guidance's
30-variant threshold unless a larger matrix was deliberately approved.

## Consequences

- Partial grids are no longer presented as complete success.
- Excessive Cartesian products refuse before mutation.
- Labeled, unlabeled, Boolean-filtered and dry-run workflows remain available.
- Dry-run is a non-confirming safe read; writes remain explicitly confirmed.
- CLI, MCP and Audit receive one deadline and structured mutation outcome.
- The direct Component Combinations Legacy Action count reaches zero.
