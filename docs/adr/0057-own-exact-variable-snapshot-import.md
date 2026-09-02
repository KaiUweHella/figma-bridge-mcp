# Own Exact Variable Snapshot Import

`tokens import-design-md` gives a present `variableSnapshot` v2 contract
priority over the adjacent legacy block. One bounded Workspace read and one
normalization complete before Plugin readiness. Only complete snapshots whose
external dependencies and default-mode topology can be recreated exactly may
dispatch; source native ids and publish keys remain evidence and never select a
target resource.

Import owns new target identity rather than merging by display name. It refuses
the transaction before writes if any local target Collection has a source
Collection name, then creates every source Collection independently. Duplicate
Collection, mode and Variable display names inside the source therefore remain
valid. The default mode is renamed in place, additional modes receive new
native ids, and all snapshot handles map only within this transaction.

Every Collection and Variable is journaled immediately after its factory
returns. All Variables and literal authored values are created before a second
pass wires same- and cross-Collection Aliases. Description, publishing
visibility, compatible scopes and code syntax are restored as authored. Source
publish keys are intentionally not copied because target publication identity
belongs to the target Figma file.

Success requires fresh native reads to prove Collection topology, exact
membership, Variable metadata, mode-key coverage, literal values and Alias
targets. Any failure after the first factory runs removes the complete journal
in reverse order. A created Collection is removed only after a fresh membership
read proves that it contains no Variable outside that Collection's command-owned
journal, so concurrent or foreign content is never cascaded away. Fresh bounded
local Collection and Variable catalogs must then agree on identity, ownership
and membership before absence is called verified. The Plugin returns only a
closed, bounded success or rollback report; host validation rejects fabricated,
oversized or structurally inconsistent results.

This first exact transaction is intentionally create-only. Re-running it into a
file that already owns a source Collection name is a conflict, not an implicit
sync. A future synchronization transaction may define explicit identity and
merge policy without weakening import safety. Legacy v1 retains its bounded
compatibility route but is never upgraded by inference or described as exact.

Figma may expose a color Alias with opacity as a readable `COMPOSE_COLOR`
expression even though `Variable.setValueForMode()` rejects that same value.
The v2 source preserves the Alias and percentage, but import rejects it during
source preflight. A literal alpha color would be visually similar but is not an
exact substitute because it destroys authored Alias identity.
