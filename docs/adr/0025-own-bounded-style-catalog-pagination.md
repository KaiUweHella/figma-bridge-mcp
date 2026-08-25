# Own bounded Style Catalog pagination

`style list` owns one compact Style Catalog Command Application shared by
Commander and MCP. It is separate from exact one-style facts and document-wide
consumer discovery because those workloads have different result shapes,
fanout and deadlines.

The request accepts an optional PAINT, TEXT, EFFECT or GRID scope, a result
limit from 1 through 500, and a versioned continuation cursor. A typed request
loads only that one native Figma style family. An untyped request starts all
four independent family reads together and then sorts by stable code-unit
`type/name/id` order. More than 10,000 candidates fails with a narrowing path.

Catalog rows deliberately contain only stable follow-up identity: id, key,
name, family and remote state. Complete authored values and publishable
metadata remain `style show` facts. The result reports scope, total, returned,
omitted-before, omitted-after, total omitted, completeness and the next cursor.
A page is `complete` only when it contains the whole requested catalog; a final
continuation page is not mislabeled as a complete catalog by itself.

The cursor is canonical Base64URL JSON with a version, scope and exact last
`type/name/id` anchor. A scope mismatch, malformed topology or missing anchor
fails before plausible output. This provides deterministic continuation without
turning opaque offsets into silent omissions when the Figma catalog changes.

Both Plugin and host enforce candidate, page, depth, value, container, key,
string and serialized-size bounds. The Plugin requires native id/key/name/type
and boolean remote metadata instead of fabricating missing values. Unknown or
malformed result fields fail on the host.

Style Consumer discovery remains a separate Application. Its native
document-wide scan needs an independently measured deadline and result budget;
Style Catalog pagination does not claim to bound that traversal.
