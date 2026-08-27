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

The immutable Style Consumer Command Plan classifies this Application for the
closed typed-read dispatch in ADR 0035. Commander and MCP send the bounded
request object without JavaScript source; the native scan no longer consumes
the Plugin mutation lane. Older authenticated runtimes may fall back once to
the existing bounded Application only when capability rejection proves the
typed read was not dispatched.

Large-document acceptance uses content-free measurements rather than retaining
document identities or node payloads. A real 29-page, 29,006-node document with
7,906 text nodes and 136 local text styles kept three Style Catalog samples at
or below 102.802 ms end to end and three Style Consumer samples at or below
50.702 ms end to end. These maxima remain below 0.35% of the Catalog's 30-second
deadline and below 0.05% of the Consumer's 120-second deadline. This evidence
does not weaken the explicit bounds or erase the separately observed long-tail
native Consumer call; the long timeout remains intentional.
