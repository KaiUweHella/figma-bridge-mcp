# Batch Variable mode values with honest rollback

`var set-value-batch` owns several explicit Variable/mode assignments as one
closed Figma Command. CLI and MCP consume one target-bound,
confirmation-configured, non-retrying Command Plan and one Command Application.
The request and Outcome name `best-effort-rollback` as the fixed policy.

Complete preflight resolves every local target Variable and Collection, mode,
literal or alias value, type compatibility and duplicate resolved
Variable/mode pair before the first setter. The batch then mutates
sequentially and verifies complete Variable Facts plus the exact affected mode
after every write.

Figma exposes `setValueForMode()` but no operation to remove one value from one
mode. Previously empty modes therefore remain valid normal targets instead of
being rejected for rollback convenience. Preflight classifies them as
non-reversible rollback coverage. Success commits them normally. After a later
failure, the Application restores every attempted pair with a prior value in
reverse order and reports every still-populated formerly empty mode or failed
restoration as exact bounded residue. It never calls such a result atomic or
rolled back.

`var set-value` retains its existing single-pair behavior. Metadata mutations,
Collection mode mutations, Variable creation and token import remain separate
Commands because their validation and rollback contracts differ.
