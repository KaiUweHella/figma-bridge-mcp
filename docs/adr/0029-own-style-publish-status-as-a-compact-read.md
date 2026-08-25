# Own Style Publish Status as a compact read

`style publish-status` owns one closed Style Publish Status Command Application
shared by Commander and MCP. It asks one local Style for Figma's official
`UNPUBLISHED`, `CURRENT` or `CHANGED` state; it does not need authored paints,
typography, effects or layout-grid values to answer that question.

The request accepts one bounded style id or local name and optional PAINT,
TEXT, EFFECT or GRID narrowing. Resolution is id, exact name, then one unique
case-insensitive partial name. Typed resolution loads only the requested
family. Untyped family reads start concurrently and stop at 10,000 candidates;
ambiguous or missing references fail without guessing.

The Plugin returns serialized versioned facts containing resolution evidence,
the request scope, compact Style identity and one official PublishStatus. The
host validates exact object topology, identity/query consistency, family,
status union, label lengths and a 16,384-code-unit response ceiling before
projecting public JSON. Unknown future status variants fail explicitly until
the pinned Figma typing contract is reviewed.

This replaces the legacy read that embedded complete raw Style values. That
payload was both unnecessary and lossy: an automatic ROWS/COLUMNS Layout Grid
count could cross plain JSON as `null` instead of `Infinity`. Exact authored
values remain available through `style show`, where non-JSON scalars have an
explicit versioned representation. Publish Status remains a small safe read
with no write confirmation and no Commander re-entry.
