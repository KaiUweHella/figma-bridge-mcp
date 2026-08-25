# 0065 — Measure the complete MCP runtime with content-free traces

Status: Accepted

## Context

Command Application measurements separated planning, Daemon and Plugin work,
but they did not include the released STDIO server, write confirmation, Audit,
MCP result serialization, process startup, RSS or compatibility children. A
single outer stopwatch would cover those gaps while hiding the layer that
actually dominates a regression.

## Decision

Add a maintainer-only, environment-enabled runtime trace at two existing
boundaries: the Daemon Client execution and the MCP tool result. Events contain
only action/tool names, process id, durations, byte counts and already bounded
Plugin/Bridge timing receipts. Inputs, file identities, node identities, labels
and results are never written. Trace I/O is append-only, rejects symlink final
paths where the platform supports it, and can never change dispatch, retry or
the public result.

Measure representative read, confirmed idempotent write, native Semantic
Render, Screenshot and tracked Asset Export through a real MCP STDIO client.
Start a fresh server for every workload, distinguish the first call from warm
calls, verify client/server envelope byte agreement, count the private Audit
lifecycle and sample MCP-process RSS. Attribute Daemon and Plugin segments from
the trace and classify trace pids outside the MCP process as compatibility
children.

Gate CI only on three offline server starts and repeated Tool Discovery. Use a
relative warm/startup constraint plus generous absolute ceilings. Live Figma
measurements remain private release evidence, not universal performance limits.

## Consequences

- EFF-02 covers the released transport without adding production telemetry.
- A slow segment is named instead of being inferred from total time.
- Compatibility child overhead remains measurable until its Command
  Application is migrated; it is not prematurely declared retired.
- RSS is a conditional CI gate on platforms where a process sampler is
  available and mandatory evidence in the maintainer macOS acceptance run.
- Exact MCP response size includes the server identity and safety metadata the
  client actually receives.
