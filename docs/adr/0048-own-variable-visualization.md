# Own journaled Variable visualization

`var visualize` uses one closed Variable Visualization Command Application
from Commander and `figma_run`. Its authentic Command Plan is a
confirmation-configured, target-bound, non-retrying Figma write. Neither
Adapter owns Plugin code, readiness, result semantics, cleanup or output
formatting.

An omitted Collection visualizes all bounded local Collections containing
COLOR Variables. A supplied Collection resolves by id, exact name or unique
partial name; ambiguity fails closed. The optional mode resolves independently
inside every targeted Collection. Without it, visualization uses each
Collection's declared `defaultModeId`, never array position.

The Plugin loads and validates bounded Collection and COLOR Variable catalogs,
including every authored selected-mode value, before canvas mutation. Both
literal colors and native Variable aliases remain valid authored values:
aliases are not flattened or substituted with a silent fallback. A Variable
without an authored value in the selected mode still receives its native,
editable binding and increments an explicit unresolved count; malformed
authored values fail preflight. The Inter font and all existing-page geometry
are also preflighted before the first factory call.

Each created Frame or Text node enters one reverse-order journal immediately.
The resulting palette uses semantic Auto Layout containers and directly binds
every swatch fill to its source COLOR Variable. Each Collection container gets
the selected explicit Variable mode so its visual resolution is deterministic.
Before success, the Application verifies every native binding and explicit
mode. A later failure removes the entire node journal and reports complete
rollback or typed partial residue.

Successful stdout retains `Created N color swatches`. This feature is kept as
first-class Code-to-Figma utility: it creates an editable Figma palette and is
not replaced by Variable Facts, resolved-token export, Layout Guides or Auto
Layout Grid.
