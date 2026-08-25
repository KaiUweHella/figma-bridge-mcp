# Anchor nested Design Link Registries to Workspace authority

A Design Link Registry may live below the repository root, including in a
private or generated evidence directory. Its location does not redefine the
code project boundary. When a WorkspaceIO authority is present, Design Link
selects the deepest authorized Workspace root containing the Registry's
canonical path and stores code links relative to that root.

Registry and source access still pass through the same WorkspaceIO seam. Path
canonicalization, symlink containment, byte limits and inode verification are
unchanged; a nested Registry therefore gains no authority outside its existing
Workspace root. Standalone callers without a Workspace adapter retain the
Registry-directory default for compatibility.

All Design Link actions use the same decision. A link that can be created but
cannot later be inspected, planned or accepted is an invalid partial identity
workflow, not a user path error.
