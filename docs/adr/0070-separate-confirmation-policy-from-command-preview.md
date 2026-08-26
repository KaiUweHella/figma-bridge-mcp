# Separate confirmation policy from guaranteed Command Preview

`FIGMA_WRITE_CONFIRM` is an MCP execution policy, not a dry-run contract. When
enabled it pauses configured writes until `confirm:true`; when disabled it
preserves intentional one-shot automation. Omitting `confirm` therefore cannot
express a portable non-mutating intent.

`figma_status` exposes the effective process policy as one bounded fact.
`figma_run` and `figma_render` accept `preview:true` as the configuration-
independent non-mutating contract. The Adapter still closes and validates the
request and resolves its authentic Command Plan, but it never starts Command
Application dispatch. `preview:true` wins if `confirm:true` is also present.

Preview output is a payload-free projection of the Command Plan: capability,
effects, target kind/source, execution mode, timeout, retry and Plugin dispatch
class. It never echoes JSX, command payloads, file keys, paths or labels.

The engine CLI remains direct execution. Its command-specific `--dry-run`
options retain their documented semantics; `FIGMA_WRITE_CONFIRM` and the MCP
`preview:true` parameter do not silently alter CLI behavior.
