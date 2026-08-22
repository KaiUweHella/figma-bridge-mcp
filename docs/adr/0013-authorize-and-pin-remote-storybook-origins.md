# ADR-0013: Authorize and pin remote Storybook origins

## Status

Accepted.

## Context

Storybook import and component mapping accept either a local directory or a
remote Storybook base URL. The previous remote path used the host's general
`fetch` implementation. Response size and JSON parsing were bounded, but an MCP
caller could still select an arbitrary HTTP(S) destination and redirects could
change that destination. DNS and proxy behavior also remained implicit.

Removing remote Storybook support would narrow a useful Code-to-Figma and
Figma-to-code integration. Allowing arbitrary URLs would make the Bridge a
host-network discovery primitive.

## Decision

A Remote Storybook Policy authorizes exact origins before network access. The
conventional `localhost`, `127.0.0.1`, and `[::1]` origins on port 6006 are
available without configuration. Other public HTTPS origins are configured in
`FIGMA_BRIDGE_STORYBOOK_ORIGINS`; intentional private or additional loopback
origins use `FIGMA_BRIDGE_STORYBOOK_PRIVATE_ORIGINS`. Configuration contains
origins only, without wildcards, paths, queries, fragments, or credentials.

Every redirect is reauthorized. All DNS answers must belong to the configured
origin's network scope, and the HTTP(S) connection is pinned to a validated
address while retaining the approved Host header and TLS server name. Public
origins cannot resolve to private or loopback addresses. Link-local, metadata,
multicast, unspecified, documentation, benchmark and reserved ranges are never
accepted. The native client does not consume proxy environment variables.

Connect, header, body and total deadlines are independent. Header and response
bytes are bounded, compressed responses are rejected, and JSON still crosses
the existing structured-data limits. Errors and audit projections retain no
supplied URL. Local directory imports continue through Workspace I/O.

## Consequences

Ordinary local Storybook development remains zero-configuration and local
directory workflows are unchanged. Hosted and private Storybooks require one
explicit exact-origin capability, after which base paths and approved redirects
remain usable.

Origin owners must update configuration when a Storybook moves to a different
scheme, host, or port. Private-origin configuration intentionally grants reach
to that private service but cannot grant link-local or reserved destinations.
The adapter implements only the Storybook index read and is not a general
remote-resource client.
