# Journal local Style creation

`style create` owns one closed non-retrying Command Application shared by
Commander and MCP. Its request normalizes PAINT, TEXT, EFFECT or GRID family,
one bounded non-empty name, a bounded description and a type-specific property
object. Unknown or duplicate options, excess arguments, unsafe text, unbounded
object graphs, unknown union discriminants and malformed typed values fail
before confirmation or Plugin readiness.

GRID creation accepts the same exact Layout Guide union used by Style Facts.
The versioned `{"$figmaScalar":"Infinity"}` count is decoded to native
`Infinity` inside the Plugin immediately before assignment and nowhere else.
Figma runtime write-shape restrictions can still be narrower than pinned
typings; the Bridge does not silently discard an authored property to make such
a write succeed.

Fallible resource preflight that does not require the Style, currently Text
Style font loading, runs before the native factory. The created local Style is
then journaled immediately. Metadata and property assignment occur inside one
failure boundary; any failure removes the Style. If removal fails, the result
reports exactly one typed `paint-style`, `text-style`, `effect-style` or
`grid-style` residue with its stable id. Writes are never retried.

Success returns versioned compact Style identity and empty residue. Raw paints,
typography, effects and Layout Guides remain separate Style Facts, preventing
valid non-JSON values from being coerced by an incidental mutation response.
