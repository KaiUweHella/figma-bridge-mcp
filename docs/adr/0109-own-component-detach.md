# Own Component Detach as an irreversible verified Command Application

## Status

Accepted.

## Context

`component detach` replaces one Instance with an editable Frame, but its legacy
Commander Action owns parsing, readiness, mutation code and output and performs
no fresh readback. Figma exposes no inverse operation that can recreate the
same Instance identity, complete override state and prototype relationships.

## Decision

Use one closed request for the Instance/URL target, optional Frame name and
output mode. CLI and MCP consume the same authentic, non-retrying
`component.detach` Command Plan and Command Application. Rename remains
optional and an empty legacy rename value retains the prior no-rename behavior.

Before dispatch, the Application proves exact Instance identity, main
Component, parent membership, child index and bounded override count. It calls
native `detachInstance` at most once, applies the optional name and invalidates
cached component facts. Fresh readback must prove one Frame at the same parent
index with exact membership and requested name. A thrown native sequence may
be accepted only when those postconditions are independently proven.

Every other dispatched outcome is classified as unchanged, irreversible
partial residue or unavailable verification. The Application never attempts
to recreate an Instance as an automatic rollback.

## Consequences

Normal Detach and Rename remain available to agents and users through both
Adapters. The result now carries bounded structural evidence and never invites
an unsafe retry. Recovery after partial detach is explicit because recreated
content could look similar while losing native identity and relationships.
