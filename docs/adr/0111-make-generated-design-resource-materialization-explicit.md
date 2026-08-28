# Make generated Design Resource materialization explicit

## Status

Accepted.

## Context

Semantic Render can infer reusable spacing/radius Variables and Text Styles
from numeric and typography literals. Creating every missing inferred resource
silently expands the target file's design system, however, and can produce
parallel resources when the literal was intentionally local to one screen.
Removing automatic creation entirely would also remove useful Code-to-Figma
and component-library behavior.

## Decision

Add one Generated Design Resource Policy to simple and compound Semantic
Render requests. Explicit `var:` references, their authored fallbacks and
explicit named Text Styles retain their existing resource semantics. For
implicit spacing/radius and typography candidates, the default is exact reuse
or literal preservation: reuse one exact existing generated identity when it
is unambiguous and compatible, otherwise preserve the authored literal.

The MCP boolean `materializeResources` and CLI flag
`--materialize-resources` explicitly authorize creation of unmatched generated
Variables and Text Styles. The closed request carries that decision through
native single, native batch and generated compatibility execution. A
payload-free Command Preview states whether generated creation is enabled.
Bounded Variable and Text Style reports distinguish references, reuse,
creation, binding and literal preservation; Variable ambiguity and
incompatibility remain separate outcomes.

## Consequences

Ordinary screen rendering no longer grows a design system merely because a
literal resembles a token or style. Existing exact resources are still reused,
and no authored capability is removed: callers that intend generated resources
can opt in per render, while explicit resource references remain actionable by
default. Native and compatibility paths expose the same policy and result
vocabulary, so preview and completion evidence do not depend on the selected
executor.
