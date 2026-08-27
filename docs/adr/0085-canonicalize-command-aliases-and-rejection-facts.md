# Canonicalize command aliases and project closed rejection facts

The Figma Command Grammar is the source of truth for public root names and
their intentionally supported aliases. Commander exposes the same canonical
roots and aliases, and every Adapter normalizes an alias before capability,
target and execution planning. Alias spelling therefore cannot select a
different action id, safety policy or Application.

A denied request projects bounded Command Rejection Facts before Plugin
readiness. The projection distinguishes an unknown root, unknown action,
unsupported option and malformed value without including positional payloads
or option values. Each rejection supplies one canonical accepted form or a
bounded action list. This guidance does not make the request executable and
does not relax the Command Grammar.

Variable Discovery retains its closed `list` and `find` interfaces. Collection
narrowing is not silently added with different semantics; an attempted
`--collection` instead names the exact Collection discovery sequence and the
existing collection identity carried by Variable rows. Commander preserves
raw discovery tokens only until the closed request parser has validated them,
so CLI and MCP return the same rejection class before transport access.
