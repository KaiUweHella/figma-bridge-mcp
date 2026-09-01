# Own Variable Collection deletion

`col delete` uses one closed Collection Delete Command Application from
Commander and `figma_run`. Its authentic Command Plan is a
confirmation-required, non-retrying Figma write with one target and decreasing
deadline. The MCP returns a guaranteed non-mutating preview until the caller
supplies `confirm:true`, even when global write confirmation is disabled.
Neither Adapter owns resolution, Plugin code, outcome classification or output
formatting.

The Plugin resolves one local Collection without choosing ambiguity, validates
complete Collection Facts, loads a bounded local Variable catalog and requires
exact agreement between native membership ids and Variable ownership before the
irreversible call. After `remove()`, it reloads both catalogs and proves the
Collection plus every preflighted member Variable absent.

The optional `--only-if-empty` guard is part of the same preflight and refuses
the write when native membership contains any Variable. The check and removal
remain in one Plugin dispatch, so a separate inspection cannot race with the
mutation. Normal `col delete` remains available for intentional deletion of a
Collection and its contents after explicit confirmation.

Figma exposes no exact reversal for a removed Collection and its Variables.
Failure evidence therefore distinguishes no observed change,
`irreversible-applied`, and bounded partial residue. None is retried. Successful
stdout retains the established compact id, name and Variable-count JSON.
