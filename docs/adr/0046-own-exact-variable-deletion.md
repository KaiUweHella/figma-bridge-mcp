# Own exact Variable deletion

`var delete` uses one closed Variable Deletion Command Application from
Commander and `figma_run`. Its authentic Command Plan is a
confirmation-configured, non-retrying Figma write with one target and a
decreasing deadline. Neither Adapter owns Variable resolution, Plugin code,
outcome classification or output formatting.

The request accepts a bounded batch of ids or exact names and an optional
Collection scope. The Plugin loads bounded local Variable and Collection
catalogs, resolves the optional Collection by id, exact name or unique partial
name, then resolves every Variable by id or exact name only. Duplicate input,
ambiguous exact names and different inputs resolving to the same Variable stop
before the first removal. Missing inputs remain the established non-target
result and do not prevent valid exact targets from being removed.

Figma exposes no reversal for `Variable.remove()`. After all exact targets are
dispatched sequentially, one fresh bounded catalog proves their ids absent.
Failure evidence distinguishes no target removed, a partial irreversible
batch, and unavailable post-dispatch verification. None is retried or called a
rollback. Successful stdout retains the established deleted/not-deleted lines.

This Command is the narrow supported counterpart to the permanently disabled
`var delete-all`: it preserves useful batch deletion while eliminating the old
first-match behavior across duplicate Collection names.
