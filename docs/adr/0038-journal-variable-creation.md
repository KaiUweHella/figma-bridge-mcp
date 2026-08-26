# Journal Variable creation

`var create` uses one closed Variable Create Command Application from Commander
and `figma_run`. Its authentic Command Plan is a confirmation-configured,
non-retrying Figma write with one target and decreasing deadline. Neither
Adapter owns Plugin code, cleanup or output formatting.

The request validates one bounded name, exact Collection query, official
Variable type and optional typed initial value before readiness. Variable
names and Collection queries are payload and never derive target identity. All
six current Figma types remain supported. Exact duplicate names in the target
Collection fail by default, while `--allow-duplicate` preserves deliberate
duplicate-name workflows.

The Plugin bounds local Collection candidates, resolves an exact Collection id
before an exact name, rejects ambiguous names and uses the Collection's
declared default mode for an initial value. Duplicate preflight loads only the
bounded `variableIds` membership declared by that Collection through targeted
async reads; it does not scan unrelated local Variables. It invokes
`createVariable()` exactly once and journals the returned identity immediately.
Initialization and result validation run inside a guarded post-create phase.
Success requires fresh targeted reads of both the Variable and its Collection.
Those reads prove membership, identity, type, default scope metadata and the
selected-mode value; finite numeric leaves use Figma-compatible float32
equivalence so native COLOR/FLOAT normalization is not treated as corruption.
A failure removes the new Variable and verifies that its freshly loaded owning
Collection no longer declares the Variable id. Collection membership is the
removal postcondition because Figma may briefly return a tombstoned Variable
from `getVariableByIdAsync()` after `remove()`. Cleanup failure or unavailable
membership proof returns one bounded residue identity through the shared
Mutation Report vocabulary. The write never retries after dispatch.

Successful output retains the established
`Created TYPE variable: NAME` contract. Batch creation, token import, metadata,
scope and later mode values remain separate Commands.
