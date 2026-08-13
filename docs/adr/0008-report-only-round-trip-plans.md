# Classify round trips from an explicitly accepted baseline

A Round-trip Plan compares the current code fingerprint and current normalized Figma subtree fingerprint with one Accepted Design Baseline stored on the Design Entity. The baseline is created only by the explicit `link accept` command after the user or agent has visually verified that both sides correspond. For screen entities, `link accept` requires a browser screenshot and a passing pixel-diff threshold; the measured diff and both image hashes are stored with the baseline. Linking alone does not imply acceptance.

The first code Adapter fingerprints the complete linked source file plus its export identity. This is intentionally conservative: an unrelated edit in a shared file may report `code-only`, but it cannot hide a real edit. A future syntax-aware Adapter may narrow the fingerprint behind the same planner Interface. The Figma Adapter fingerprints the normalized subtree and excludes bridge plugin data, credentials and source paths.

The Round-trip Planner is report-only. `unchanged`, `code-only`, `figma-only`, `conflict` and `untracked` describe evidence; none authorizes a mutation. In particular, a conflict never picks a winner. This extends the three-way decision pattern used by token sync without turning visual code and Figma trees into falsely comparable structures.
