# Own signed Node movement behind one closed request

`node move` uses one closed Node Move request and Command Application shared by
Commander and `figma_run`. The request recognizes bounded finite signed X/Y
positionals before rejecting unknown options, accepts the existing `--`
delimiter and optional Page target, and canonicalizes every accepted spelling
into one Command Plan. Figma URL identity comes only from the parsed Node
Reference.

Commander retains the raw tokens for this action because its generic option
parser otherwise treats a negative positional as an option. This exception
does not widen the command: the closed request rejects every unknown option,
duplicate Page selector, missing value and excess positional before readiness
or confirmation. MCP projects that exact request error instead of invoking the
legacy child-process Adapter.

The Application preserves absolute-canvas semantics for nested nodes by
translating from the node's current absolute bounds into parent-relative X/Y.
An optional Page is resolved and loaded before the first mutation. The result
is bounded and success requires fresh absolute-coordinate readback within one
small numeric tolerance. A mismatch after dispatch remains an execution
failure rather than a successful setter claim. `node set --x/--y` uses the same
finite coordinate validator, so the two public placement surfaces cannot
silently diverge on numeric bounds.
