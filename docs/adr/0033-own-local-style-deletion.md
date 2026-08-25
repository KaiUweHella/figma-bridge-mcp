# Own local Style deletion without retry or rollback claims

`style delete` owns one closed non-retrying Command Application shared by
Commander and MCP. Its request accepts one bounded Style id or local name and
optional PAINT, TEXT, EFFECT or GRID narrowing. Resolution is id, exact name or
one unique case-insensitive partial name within 10,000 candidates. Unknown,
duplicate, malformed and excess input fails before confirmation or readiness.

Remote Styles cannot be removed. The Application captures compact publishable
identity before calling Figma's synchronous `remove()`. Success reports that
identity and empty residue without raw paints, typography, effects or Layout
Guides. This prevents a GRID Auto count from becoming lossy JSON `null` in an
incidental deletion result.

Figma provides no undo handle to the Plugin after Style removal. A thrown
remover therefore reports unknown post-dispatch outcome and bounded possible
Style residue; it never claims rollback and is never automatically retried.
