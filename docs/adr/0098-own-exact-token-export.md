# Own exact Token Export behind one Command Application

## Status

Accepted.

## Context

`export css` and `export dtcg` duplicated readiness, generated eval, parsing,
formatting, failure and persistence inside Commander. MCP therefore reached
them only through legacy process execution. The scoped collector also stopped
after 2,000 referenced Variables without reporting truncation, while the
file-wide path combined all local Variable values in one unpinned response.

The two useful scopes are intentionally different. A node-scoped export must
follow bindings into enabled libraries and exclude unrelated local design
systems. A file-wide export must include every local Collection and every mode,
which can exceed one Plugin payload and therefore needs multiple reads.

## Decision

CSS and DTCG use one closed Token Export request and one value-returning
Command Application shared by Commander and `figma_run`. The request preserves
the existing optional DTCG output, node-in-either-slot shorthand and legacy or
2025 dialect while making target and Workspace effects authoritative in the
Command Plan.

An explicit node uses one deeply bounded subtree capture. It walks iteratively,
includes direct, paint and applied-Style bindings, follows complete Alias
chains, resolves library Variables, and fails rather than truncating or
silently falling back to the file-wide scope.

A file-wide request reuses the Portable Variable Snapshot catalog and chunk
validators. Every catalog and value read carries daemon-owned connection, file
and document-revision metadata; a final catalog fence must match before host
projection or DTCG publication. Chunk transport may retry smaller after a
payload or timeout failure but never drops a chunk. Host formatting preserves
all Collection modes and declared defaults. The final CSS/DTCG projection is
bounded by Workspace text authority even when returned on stdout.

Variable identity is not the same as a display-name path. When separate Figma
Collections contain names that collide, the exporters keep every Variable:
CSS uses Collection-qualified custom properties and DTCG places the colliding
tokens under deterministic `figma-collections` groups. DTCG alias references
are rewritten from exact Variable ids to those projected paths, and the Bridge
extension retains the original Variable name. Figma `TIMING` values remain
seconds in CSS and standard DTCG duration values; bounded numeric cleanup
removes only float-storage noise.

## Consequences

CLI and MCP now share target resolution, timeout, safe-read retry, capture,
validation, multi-mode projection and errors without Commander re-entry.
DTCG files are written only after complete capture and formatting. CSS remains
stdout-only; DTCG stdout remains parseable because source diagnostics stay on
stderr. Existing node-scoped library-token utility and file-wide workflows
remain available, while missing revision proof, drift, overflow and incomplete
identity become explicit failures instead of plausible partial output.
Legitimate cross-Collection name overlap no longer drops CSS declarations or
aborts DTCG export.
