# Own Component Override Removal as a verified Command Application

## Status

Accepted.

## Context

`component overrides` directly parses and executes native Instance mutations in
the Commander Adapter. It reports counts from the same object without a fresh
read, so an acknowledgement error, ineffective write or partial result cannot
be classified safely. Its public `reset` action calls Figma's deprecated
`resetOverrides()` API, while Figma documents both `resetOverrides()` and
`removeOverrides()` as removing all direct overrides.

## Decision

Use one closed request for the Instance/URL target, `reset | remove` action and
output mode. Keep both public action spellings as compatible aliases. CLI and
MCP consume the same authentic, non-retrying `component.overrides` Command Plan
and Command Application.

Before dispatch, prove exact Instance identity, main Component, parent identity
and a bounded canonical snapshot of direct override entries and fields. A
zero-override Instance is a verified no-op. Otherwise call current native
`removeOverrides()` at most once, invalidate cached component facts and verify
from a fresh Instance read that identity and relationships are unchanged and
the direct override count is zero. A thrown acknowledgement is successful only
when that postcondition is independently proven.

Every other dispatched outcome is classified as unchanged, partial residue or
unavailable verification. The Application never retries after dispatch.

Native Figma acceptance confirms that an explicitly changed Instance layer
name is itself part of the direct override state and is therefore restored to
the Component name by this operation. The Application reports the fresh name
without incorrectly requiring it to remain equal to the preflight name.

## Consequences

Agents and users retain both existing action names and the full native behavior
of removing all direct overrides. The implementation no longer depends on a
deprecated API name, and CLI, MCP and audit projections receive bounded,
truthful mutation outcomes.
