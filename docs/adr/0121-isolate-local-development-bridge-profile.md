# ADR 0121: Isolate the local-development Bridge profile

## Decision

`FIGMA_BRIDGE_PROFILE=local-development` selects one closed contributor
profile. It stores all Bridge state below
`~/.figma-bridge-mcp/profiles/local-development/`, pins Daemon discovery to
port 3460, and pairs with the generated checkout-owned
`plugin/local/manifest.json` under a distinct local-development plugin id and
name. The whole `plugin/local/` import bundle is gitignored and refreshed from
tracked templates and the canonical Plugin assets. The tracked
`plugin/manifest.json` therefore always remains Figma's directly importable
released identity. The Plugin main thread passes the local identity's exact
port into the shared UI, and the local manifest permits only 3460. The default
released manifest and 3456–3460 fallback remain unchanged.

The owner-private root remains `~/.figma-bridge-mcp/`; permission enforcement
covers both the default namespace and the nested contributor profile as one
exact tree. The local profile never migrates or reuses the default profile's
pairing key, so its separate Figma plugin asks for its own key once.

## Context

A released MCP server and a source checkout can run concurrently on one Mac.
An earlier port-only override still left the two processes sharing PID, port,
session-token, access-key and copied-plugin paths. In addition, the ordinary
Figma plugin scanned every allowed port in parallel, so the first responding
Daemon could capture the wrong plugin even when the source Daemon bound 3460.

## Consequences

The two Bridge installations can be tested concurrently without stopping or
upgrading each other. Contributors run `figma_connect` with the profile (or
`npm run prepare:plugin-imports`) and import `plugin/local/manifest.json` from
the active checkout once. Port 3460 is intentionally reserved for this
profile; an explicit `DAEMON_PORT` remains authoritative for controlled
diagnostics, while the generated local plugin continues to receive the closed
profile port range.
