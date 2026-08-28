# Journal Variable batch creation

`var create-batch` uses one closed Variable Batch Creation Command Application
from Commander and `figma_run`. Its authentic Command Plan is a
confirmation-configured, non-retrying Figma write with one target and a
decreasing deadline. Neither Adapter owns JSON semantics, Plugin code,
cleanup, result validation or output formatting.

The request parses and validates the complete JSON batch before readiness. It
accepts at most 256 Variables, defaults an omitted type to `COLOR` for
compatibility, and otherwise preserves all six official Variable types and
their complete value shapes. An item may carry either `value` or an explicit
`alias`, never both. `aliasCollection` can scope an Alias target by exact
Collection id or unambiguous exact name. Unknown fields and invalid values fail
closed. Exact duplicate names are rejected by default across both the request
and the target Collection; `--allow-duplicate` preserves intentional
duplicate-name workflows.

The Plugin bounds local Collection and Variable catalogs, resolves one local
Collection by id or exact name, and resolves an optional mode by id, exact name
or unique partial name. Without `--mode`, it uses the Collection's declared
`defaultModeId`, never array position. Alias targets resolve by exact id first
or otherwise by one exact name, optionally inside `aliasCollection`; a target
may be local to another Collection or planned later in the same batch. Type
mismatches, ambiguous targets and same-batch Alias cycles fail before the first
factory. Literal equality is never Alias inference. Collection, mode,
existing-name and native-identity preflight completes before the first factory
call.

Creation is sequential and non-retrying. Each returned Variable enters the
journal before initialization. All factories complete before a second pass
writes selected-mode literals or native Alias objects, so explicit forward
references retain identity without extra Commands or confirmations. A fresh
local catalog must then prove every created id, name, type, Collection owner,
selected-mode value and exact Alias target. If any factory successor,
initialization or result projection fails, the Application removes the entire
journal in reverse and verifies exact absence. Failure distinguishes complete
rollback, partial residue and unavailable cleanup verification through bounded
Mutation Report evidence. COLOR verification treats authored RGB and Figma's
native opaque RGBA `a: 1` plus Float32 channels as equivalent, while
non-opaque alpha, extra fields and actual channel drift remain failures.

Successful stdout retains the established `Created N variables` contract.
Separate single creation remains preferable when an operation needs only one
Variable; batch creation remains first-class because reducing Plugin
round-trips is core Code-to-Figma utility, not a compatibility exception.
