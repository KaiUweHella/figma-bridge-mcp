# Normalize font weights at the Semantic Render Plan boundary

Equivalent authored font-weight spellings must not select different Figma
execution paths. JSX, browser capture, auto-split and batch therefore converge
on one canonical representation before Structural Gate and native executor
preflight: supported semantic names and numeric strings become numeric weights.
`bold`, `"700"` and `700`, for example, all become the number `700`.

The normalization belongs to Semantic Render Plan creation rather than an
individual adapter or executor. This keeps CLI and MCP projections identical,
lets native support inspection operate on the same facts that are executed,
and leaves generated execution available only for genuinely unsupported plan
facts or older Plugin capabilities.

FLOAT Variable references retain their `var:` identity. When they include a
literal fallback, only that fallback is canonicalized. Rich Text run weights
follow the same rule as their parent Text node. Context-dependent relative
values such as `bolder`, unknown names and out-of-range numeric values stop at
the Plan boundary because they cannot be mapped exactly without external font
and inheritance context.

The Plan validator accepts only canonical weights. This makes a Plan created by
an adapter and a Plan received from another boundary obey the same invariant
before any Figma mutation.
