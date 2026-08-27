# Verify node typography Variable bindings by fresh readback

`font bind` and `font unbind` own one closed, non-retrying Command Application
shared by Commander and MCP. Its request accepts one bounded semantic Text
Node Reference, one supported typography field, optional bounded character
range, and—for binding—one bounded local Variable id/name plus optional
Collection id/name. Exact ids may retain an imported remote Variable; name and
Collection resolution remains local and ambiguity-safe. Unknown, duplicate, missing or excess input fails before
confirmation or Plugin readiness.

Before the first write, the Plugin resolves one mutable Text Node, a compatible
STRING or FLOAT Variable, and the prior field/range binding needed for
restoration. Name resolution rejects ambiguity; optional Collection narrowing
must itself resolve uniquely. Required fonts are loaded before mutation.

A setter return is not proof of success. The Application freshly reads
`boundVariables[field]` or `getRangeBoundVariable(...)` and accepts the
operation only when the observed Variable Alias id exactly matches the
requested id, or is exactly unbound for `font unbind`. Setter exceptions,
silent no-ops, malformed aliases, and mismatched ids cannot return success.

After a failed or mismatched write, the Application restores the resolved prior
Variable or prior unbound state and verifies that restoration by the same fresh
readback. A proven restoration reports `rolled-back`; an unproven restoration
reports bounded residue containing only node identity, field, range and the
observed alias id. Neither path retries automatically. Results expose compact
identities and never raw Text Node content or authored typography values.
