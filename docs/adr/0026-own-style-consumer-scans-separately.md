# Own Style Consumer scans separately

`style consumers` owns one closed Style Consumer Command Application shared by
Commander and MCP. It is not part of Style Facts or Style Catalog because
Figma's native `getStyleConsumersAsync()` performs a document-wide read whose
latency and fanout differ materially from one-style lookup.

The request accepts one bounded style id or local name, optional family
narrowing, a page limit from 1 through 500 and a versioned continuation cursor.
Resolution is id, exact name, then one unique case-insensitive partial name.
Typed resolution loads only the requested family; ambiguous, missing and stale
references fail with bounded neutral errors.

The native API returns its whole candidate array and exposes no interruptible
visit budget. The Bridge does not claim otherwise. Results therefore contain a
separate scan fact: API `getStyleConsumersAsync`, `complete: true` after the
native promise resolves, and `interruptible: false`. The outer `complete`
describes only whether the projected page contains the whole consumer set.
Style Consumer gets the Capability Catalog's long timeout class rather than
sharing the ordinary catalog-read budget.

At most 100,000 native candidates are accepted, and at most 500 compact rows
cross one page. Each row preserves node id/name/type and the exact sorted set of
official inherited-style fields. Duplicate node/field identities, unknown
fields, malformed metadata and oversized depth/value/container/string/byte
results fail instead of becoming plausible consumer evidence.

The versioned Base64URL cursor is bound to the original query and requested
family. Its exact anchor is node id plus inherited-style field set. Results
report total, returned, omitted-before, omitted-after, total omitted,
completeness and next cursor. A final continuation page remains incomplete as a
standalone catalog of consumers even when no later page remains.

Separating a typed read dispatch lane remains future work. Until that seam is
implemented, the long native read still uses the authenticated Plugin dispatch
path and may contend with writes; this limitation is tracked independently
rather than weakening write serialization.
