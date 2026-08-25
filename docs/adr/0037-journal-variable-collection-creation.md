# Journal Variable Collection creation

`col create` uses one closed Collection Create Command Application from
Commander and `figma_run`. Its authentic Command Plan is a confirmed,
non-retrying Figma write with one target and decreasing deadline. Neither
Adapter re-enters Commander or owns Plugin code, cleanup or formatting.

The request owns one bounded Collection name and optional explicit
`--allow-duplicate` intent before confirmation or readiness. A name is payload
and never derives Figma Target Context. Literal dash-prefixed names survive the
`--` boundary; control characters, unknown or duplicate options and excess
positionals fail before effects.

Before the factory call, the Application loads a bounded local Collection
catalog and rejects an exact-name collision unless duplicate intent is
explicit. This makes accidental ambiguous token containers fail safely without
removing Figma's legitimate duplicate-name capability.

The Plugin calls `createVariableCollection()` exactly once and journals the
returned identity immediately. Result validation and bounded serialization run
inside a guarded post-create phase. A failure removes the created Collection;
cleanup failure returns bounded residue identity. The host validates success or
failure evidence and projects rollback versus possible residue through the
shared Mutation Report contract. The write is never retried.

Successful stdout retains the established `✓ Created collection: NAME` text so
existing CLI and MCP workflows are not restricted. Mode creation, Variable
creation and all edits remain separate Commands.
