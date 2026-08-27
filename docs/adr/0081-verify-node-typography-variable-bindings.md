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
must itself resolve uniquely. When Figma's direct Variable lookup is
temporarily unavailable, an exact id may fall back only to the bounded local
Variable catalog; remote identity is never guessed. Required fonts are loaded
before mutation.

A setter return is not proof of success. The Application freshly reads
the selected character range with `getRangeBoundVariable(...)` and accepts the
operation only when the observed Variable Alias id exactly matches the
requested id, or is exactly unbound for `font unbind`. Text Node
`boundVariables[field]` is an alias array even for a uniform binding; it is not
treated as the Style-side scalar shape. A mixed selected range is captured as
bounded contiguous styled segments before an explicit overwrite. Setter
exceptions, silent no-ops, partial range overrides, malformed aliases, and
mismatched ids cannot return success.

After a failed or mismatched write, the Application restores the resolved prior
Variable, prior unbound state, or every journaled mixed segment and verifies
that restoration by fresh range readback. A proven restoration reports
`rolled-back`; an unproven restoration reports bounded residue containing only
node identity, field, range and the observed alias id. Neither path retries
automatically. Results expose compact identities and never raw Text Node
content or authored typography values.
