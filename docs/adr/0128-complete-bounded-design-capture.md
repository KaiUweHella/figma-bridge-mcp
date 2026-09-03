# 0128. Complete bounded Design Capture

Date: 2026-09-02

## Status

Accepted

## Context

The Northern acceptance screen (`362:1846`, 826 layers) could not be read
exactly. One plugin eval walked the whole subtree with native Inspect CSS and
Variable suggestions per layer; its result (about 8.5 KB per layer, 4.3 MB at
depth 6 alone) exceeded the 5 MB plugin message limit, so the socket closed and
the host saw only "plugin disconnected". Long walks also approached the 22–25 s
transport window. The style phase then correctly refused every depth-limited
tree, and the MCP result budget (60,000 characters) could not carry a complete
projection anyway. The implementation that followed was built from the
screenshot and depth-limited structure maps, which is exactly what the
design-to-code workflow forbids: colours, gradients, blend modes, overlay
geometry and whole layers were interpreted instead of copied.

## Decision

- The plugin walker accepts a wall-clock budget and a serialized-size budget
  for one eval. Every captured layer's own fields are counted once before its
  children are walked. Once either budget is exceeded, the walker still
  captures the current layer but reports every remaining subtree as a
  `frontier` with `budgetCut: true`, reusing the vector-cluster collapse that
  the depth limit already applies.
- The Design Capture Module walks each budget-cut frontier child in its own
  bounded eval at the depth that remains below it and splices the frames into
  the cut. Every stitched eval must observe the same connection, file and
  revision as the root walk; a changed document fails explicitly. Component
  sets merge by identity. `completeness` reports `budgetLimited`,
  `stitchedCaptures` and `budgetCuts`; a delivered complete Capture has no
  `budgetCut` seam left.
- `complete: false` returns the first bounded eval with its seam visible; the
  default is a complete Capture.
- `export code-spec -o/--output` and `figma_spec outFile` persist the complete
  projection through WorkspaceIO under the Command Plan's owned output path
  and return summary facts (node, phase, depth, visible/unaccounted layers,
  plugin evals, bytes). Code Spec belongs to the long timeout class.
- The Design Capture schema version is 7.

## Consequences

- Large screens are read exactly and completely; the honest limit becomes the
  Command deadline, which is reported instead of degraded silently.
- Chunk budgets of 12 s and 2.5 MB keep every eval inside the transport
  window and the message limit; the number of plugin evals grows with the
  screen, not the depth (the Northern screen needs about four).
- Inline `figma_spec` results keep their budget and dedup fallback; complete
  large captures are read from the workspace file.
- Stitched captures are cached like single-eval captures under the same
  revision-aware key.
