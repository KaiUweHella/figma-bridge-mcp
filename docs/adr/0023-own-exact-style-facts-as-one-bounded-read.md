# Own exact Style Facts as one bounded read

`style show` owns one closed Style Facts Command Application shared by
Commander and MCP. Its Interface accepts exactly one bounded style id or local
name. Resolution is id, then exact local name, then one unique
case-insensitive local substring; ambiguous and missing references stop with
bounded neutral errors. Style queries never contribute a Figma URL target.

The versioned result preserves publishable id, key, name, remote state, plain
description, Markdown description and documentation links. PAINT, TEXT, EFFECT
and GRID family values retain their nested authored topology together with
scalar Text Style bindings and array Paint/Effect/Grid Style bindings. Nested
paint, gradient-stop, effect and grid bindings remain in place. Image/video
hashes, pattern node ids and shader ids/properties are facts only; this read
does not load bytes or definitions.

The live Figma runtime can omit `description` or `descriptionMarkdown` even
though current Plugin typings declare both required. Style Facts records that
absence as `null`; it does not substitute one representation for the other or
silently omit the result key.

JavaScript values cross a JSON transport without silent semantic loss.
Figma's one supported non-JSON Style scalar is encoded as the versioned object
`{"$figmaScalar":"Infinity"}` only at a ROWS/COLUMNS GRID `count`; every other
number must remain finite. This is required for the official GRID Auto count,
whose JavaScript value is `Infinity` and would otherwise become `null`.

Both Plugin and host enforce depth, value, container, key, string,
documentation-link and serialized-size limits. The host also rejects unknown
Style families and Paint, Effect or Grid union discriminants. Text typography
and Variable Alias topology receive independent structural validation. Excess,
malformed or drifted results fail rather than truncating into plausible Style
Facts.

Resolved Variable values, style consumers, binary assets, shader definitions,
arbitrary Plugin data and complete Design Capture remain outside this Module.
Style Catalog and Style Consumer Facts are separate Applications because their
fanout, timeouts and completeness contracts differ from one-style capture.
