# Gate unsafe Legacy bulk mutations until typed Operations exist

Legacy bulk writes that can begin irreversible mutation before complete bounded
preflight are unavailable through both Commander and MCP. The initial gates
cover `var delete-all`, page-wide `tokens rebind --apply`, and `node set|bind
--batch`. Capability admission rejects them before confirmation, readiness,
Audit start or Plugin dispatch; Commander repeats the same product boundary
before checking Bridge availability.

The gate is deliberately mode-specific. Exact `var delete` and `col delete`,
single-node `node set` and `node bind`, page-wide Token Rebind dry-run, and
node-scoped Token Rebind apply remain available. This preserves ordinary
Code-to-Figma utility while refusing only modes whose ambiguity, traversal,
partial-mutation or result-size risk cannot yet be reported truthfully.

A gated mode may return only behind one closed typed Command Application with
explicit request/result bounds, exact target identity, complete preflight
before the first mutation, one decreasing deadline, reversible mutation
journaling where the Figma API permits it, bounded rollback/residue facts and
no automatic retry after dispatch. Re-enabling a Commander-only compatibility
branch is not sufficient.
