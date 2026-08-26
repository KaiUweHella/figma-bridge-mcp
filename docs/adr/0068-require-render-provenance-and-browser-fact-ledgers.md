# Require render provenance and browser fact ledgers

A whole-image diff can reveal that a build differs from Figma, but it cannot
prove that each rare source fact survived implementation. The Northern
publication run lost blend modes, decorative layers, asymmetric strokes,
typography roles, an effect stack and responsive fill sizing even though the
source capture contained those facts. In the reverse direction, an existing
browser UI was manually rewritten as JSX and silently lost CSS structure.

Every Semantic Render Plan now names its bounded adapter and provenance. A
Browser DOM Capture carries its schema version, SHA-256 digest and viewport.
The Figma Render Executor persists that evidence as root plugin data; Design
Capture exposes it, and Design Link inspection plus acceptance can require the
`dom-capture` adapter for an existing rendered UI. JSX remains a supported
source for a new view, component or explicitly reviewed semantic boundary.

Figma-to-code acceptance additionally uses a Browser Fidelity Ledger. A
reviewed ledger maps bounded source-node facts to one deterministic capture
path or Design Entity. The verifier classifies every fact as `matched`,
`approved-deviation` or `missing`; absent, ambiguous, unavailable and unequal
facts fail closed. Computed styles permit token-backed CSS equivalence, while
font-role facts also require browser Font Loading API evidence. The ledger is
limited to 500 facts and rejects unknown properties and malformed identities.

Complete Browser DOM Captures retain a separate hard workspace envelope:
32 MiB and 500,000 lexical/graph entries with the normal nesting limit. This
is large enough for composed production screens whose computed-style fields
legitimately exceed the generic JSON collection budget, while remaining a
bounded untrusted input. Both `render --dom-capture` and `verify-build` consume
the same envelope.

Visual comparison remains required where the workflow contract calls for it.
Neither provenance nor the fact ledger claims pixel equality; together they
make source omissions and the wrong Code-to-Figma adapter mechanically visible
before a baseline or release is accepted.
