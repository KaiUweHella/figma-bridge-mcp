# Own Component Property List as a bounded Read Application

## Status

Accepted.

## Context

`component prop list` reads local Component and Component Set definitions by
explicit node or current selection, but its Commander Action still owns Plugin
readiness, generated eval code and human formatting. MCP therefore cannot use
the same bounded typed result without re-entering Commander.

## Decision

Use one closed request for the optional Component/URL target and output mode.
CLI and MCP consume the same authentic `component.prop.list` safe-read Command
Plan and bounded Read Application. Explicit targets and current-selection mode
remain available. The result retains every native property type, scalar default
and Variant option while enforcing bounded counts, strings and serialized
output. Human output and structured JSON are rendered from the same validated
payload.

## Consequences

Component property discovery needs no write confirmation and is safe to retry.
CLI and MCP now agree on target resolution, completeness and output validation.
The read does not add filters or hide newer native property types; unsupported
or oversized metadata fails explicitly instead of returning a partial list.
