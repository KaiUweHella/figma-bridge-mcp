# Bind Plugin execution with Dispatch Receipts

Every authenticated Plugin action carries one closed, bounded and versioned
Dispatch Receipt prepared by the Bridge Daemon from the exact connection
selected for the immutable Figma Target Context. The receipt binds a random
request identity, the handshake-signed connection epoch, file-key or
connection-scoped draft identity, expected editor and advertised operation
capability.

The Figma Plugin validates the receipt against its live document and editor
inside the serialized execution lane, immediately before any Figma operation.
A target, editor, capability, stale-connection or elapsed-deadline mismatch is
returned as `not-dispatched`. Figma Design-only Semantic Render Plans are
rejected in FigJam, Slides and Dev Mode while their editor-specific eval
workflows remain available.

Every terminal response echoes the same receipt identity with `completed`,
`not-dispatched`, `failed` or `unknown`. A missing, malformed or identity-
mismatched terminal receipt is an unknown outcome after dispatch. A reconnect
creates a new signed epoch, and stale responses cannot settle work owned by the
new connection even if a numeric protocol id collides.

Receipt identity is transport-internal. Freshness caches may consume the
selected connection and file facts, but Audit and user-facing error projections
retain only their existing redacted target summary and the closed terminal
dispatch state.
