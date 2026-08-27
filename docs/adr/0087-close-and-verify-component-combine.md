# Close and verify Component Combine

`component combine` previously exposed a plural mutation through a Commander
handler with one positional value. The Capability Catalog accepted repeated
Component ids, but the handler split only its first value on commas. Later
positionals could therefore survive planning and confirmation while never
reaching Figma.

One closed Component Combine request now owns comma-separated and repeated
Node References, options, bounds, duplicate rejection, canonical argv and URL
target projection. CLI and MCP execute the same non-retrying Command
Application. Every requested node resolves before mutation and must be a
standalone local Component. Inputs from different pages, remote library
Components and Components below an Instance, Component or Component Set fail
preflight. An existing Component Set directs the caller to the supported
`["component","add-variant","<set>","Axis=Value"]` operation.

The mutation combines onto the Components' shared source page instead of
assuming that the currently visible page owns them. It then reads the new Set
again and verifies its name, exact membership, Variant parents and the mapping
back to every ordered request input. The returned Variant order is the fresh
native child order and includes each request index; it is not inferred from a
count or from the pre-mutation selection.

This keeps both ergonomic plural spellings without broadening the operation.
It does not merge Component Sets or silently add Variants to an existing Set.
