# Dispatch Node Binding Facts as a Typed Read

Node Binding Facts has one closed versioned operation, `node-bindings-v1`,
shared by Commander and MCP. Its request contains exactly one nullable Node id.
It cannot carry JavaScript or executable data, and the Plugin validates the
same Node, fact, catalog, field, label, identity and serialized-result bounds
as the host Application.

The native operation preserves the established Facts semantics: scalar,
array-position and component-property topology; one lazy bounded local
Variable and Collection catalog; exact remote lookup only when an Alias is not
local; and explicit unresolved remote identity. A parity contract keeps this
projection equal to the older generated-eval implementation while that
compatibility path remains supported.

The immutable Command Plan classifies `node.bindings` as `typed-read` before
either Adapter can dispatch it. This lets the Daemon schedule the operation on
the bounded read lane instead of serializing it behind opaque document writes.
Target, editor, authenticated connection epoch, deadline, Dispatch Receipt,
result validation, audit and error handling stay unchanged.

Commander and MCP may execute the bounded generated-eval implementation once
only when an older Plugin returns a structured capability or validation error
with a proven `not-dispatched` outcome. No timeout, malformed result,
disconnect, post-dispatch error or unknown outcome may cross that fallback.
