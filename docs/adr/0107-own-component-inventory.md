# Own Component Inventory as a bounded Read Application

## Status

Accepted.

## Context

`component list` already collected a complete, bounded Component Inventory and
validated the Plugin response. Its direct Commander Action still owned
readiness, dispatch, formatting and process behavior, while MCP re-entered
Commander for the same read.

Current-page discovery is the common fast path. Full-file discovery through
`--all-pages` is also necessary for real design-system libraries and must not
be removed merely because it can take longer on large files.

## Decision

Use one closed `component.list` request and one authentic safe-read Command
Plan from CLI and MCP. Keep current-page and all-page scopes, complete bounded
Component Set, Variant-axis, default-Variant, standalone Component, page,
file-local identity and publish-key facts, plus human and JSON output.

The Command Application reuses the existing bounded collector and host
projection. It additionally verifies that the returned scope matches the
request. Current-page reads retain the default deadline; explicit all-page
reads receive the long read budget. Both are safely retryable because they do
not mutate the Figma document.

## Consequences

CLI and MCP now consume one target, readiness, retry, deadline, validation and
formatting contract without Commander re-entry. Full-file library discovery
remains available and complete within the existing explicit bounds. Malformed,
oversized, duplicate-identity or scope-mismatched results fail rather than
becoming plausible partial inventories.
