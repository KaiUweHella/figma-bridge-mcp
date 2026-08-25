# Journal Variable batch creation

`var create-batch` uses one closed Variable Batch Creation Command Application
from Commander and `figma_run`. Its authentic Command Plan is a
confirmation-configured, non-retrying Figma write with one target and a
decreasing deadline. Neither Adapter owns JSON semantics, Plugin code,
cleanup, result validation or output formatting.

The request parses and validates the complete JSON batch before readiness. It
accepts at most 256 Variables, defaults an omitted type to `COLOR` for
compatibility, and otherwise preserves all six official Variable types and
their complete value shapes. Unknown fields and invalid values fail closed.
Exact duplicate names are rejected by default across both the request and the
target Collection; `--allow-duplicate` preserves intentional duplicate-name
workflows.

The Plugin bounds local Collection and Variable catalogs, resolves one local
Collection by id or exact name, and resolves an optional mode by id, exact name
or unique partial name. Without `--mode`, it uses the Collection's declared
`defaultModeId`, never array position. Collection, mode, existing-name and
native-identity preflight completes before the first factory call.

Creation is sequential and non-retrying. Each returned Variable enters the
journal before its optional initial value is set. A fresh local catalog must
then prove every created id, name, type, Collection owner and selected-mode
value. If any factory successor, initialization or result projection fails,
the Application removes the entire journal in reverse and verifies exact
absence. Failure distinguishes complete rollback, partial residue and
unavailable cleanup verification through bounded Mutation Report evidence.

Successful stdout retains the established `Created N variables` contract.
Separate single creation remains preferable when an operation needs only one
Variable; batch creation remains first-class because reducing Plugin
round-trips is core Code-to-Figma utility, not a compatibility exception.
