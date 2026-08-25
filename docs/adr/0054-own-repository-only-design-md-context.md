# Own Repository-Only DESIGN.md Context

`tokens import-design-md --print-context` executes one shared CLI/MCP Command
Application. Its authoritative Command Plan resolves and authorizes exactly one
DESIGN.md input, records only a Workspace read, selects no Figma target and
requires neither write confirmation nor Plugin readiness. MCP executes the
Application in-process; Commander delegates the same Plan instead of parsing
or printing the document itself.

DESIGN.md parsing no longer derives filesystem authority from the input path.
`parseDesignMd` requires an existing WorkspaceIO capability and reads through
it once. `parseDesignMdText` retains an independently testable pure parsing
seam after the document byte bound has been established. Relative, absolute
and symlinked paths therefore receive the same canonical Workspace checks.

The context projection is also an untrusted-output boundary. Source labels,
style text, token names, values and component labels escape terminal and Bidi
controls, cap individual fields and sample large categories. The complete
summary has an explicit code-unit ceiling; it never expands an arbitrary
structured token value into prompt or terminal output.

This decision owns only the repository-only context action. Simple
single-Collection import will reuse the existing Token Import Application after
DESIGN.md normalization. Multi-Collection Variable Snapshot import remains a
separate versioned transaction because its identity and mode topology cannot be
made faithful by the context reader.

The top-level design-source `import --print-context` policy follows the same
no-target rule. Converted sources project bounded context in memory and do not
create the former temporary DESIGN.md or an implicit Storybook output file.
An explicit `--save` remains an intentional Workspace write while still
requiring no Plugin connection.
