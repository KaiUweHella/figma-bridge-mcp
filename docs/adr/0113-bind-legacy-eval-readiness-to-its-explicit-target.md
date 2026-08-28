# Bind Legacy Eval readiness to its explicit target

Raw `eval` and its `run` file alias remain CLI-only compatibility tools for
maintainers. They previously performed a generic Plugin-presence check before
the Daemon Client independently resolved the global `--figma-file` value.
With several Plugin windows, the check could therefore accept an unrelated
socket or fail to prove that the requested Figma main thread was responsive.

Resolve the CLI target once before readiness. One deadline now covers the
target-scoped authenticated responsiveness probe and the subsequent arbitrary
evaluation. The exact resolved file key and expected editor accompany both
steps; only the remaining deadline reaches the Daemon execution request. The
Daemon's existing Dispatch Receipt continues to reject a target or connection
epoch mismatch at the Plugin boundary.

An omitted target retains existing single-window compatibility. With multiple
windows the Daemon still refuses ambiguity; no active-window fallback exists.
Raw evaluation remains absent from the MCP Capability Catalog and cannot be
reached through `figma_run`. This change repairs direct CLI compatibility
without widening the MCP execution surface or weakening confirmation policy
for supported commands.
