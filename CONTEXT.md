# Figma Bridge

Figma Bridge exposes safe, scriptable Figma operations to both MCP agents and
human CLI users while preserving one authenticated plugin transport.

## Language

**Figma Command**:
One validated request to read from or write to a specifically targeted Figma file. A command has one audit lifecycle regardless of which adapter invokes it.
_Avoid_: CLI command, MCP call

**Command Application**:
The value-returning execution of a **Figma Command**, independent of Commander, MCP, console output, or process exit behaviour.
_Avoid_: handler, command service

**Command Capability**:
The resolved policy for one concrete **Figma Command** before execution: Adapter exposure, Figma/workspace/shared-state effects, target requirement, normalized paths, confirmation, retry, timeout, accepted exit codes and background-job identity.
_Avoid_: allowlist entry, command metadata

**Design Capture**:
The canonical, lossless Figma facts collected for one node and one set of capture options, bound to a Bridge Daemon connection and document revision. Structure, style, deduplication, enrichment and serialization are projections of a Design Capture, never inputs that reduce it.
_Avoid_: walker output, cache entry

**Bridge Daemon**:
The authenticated localhost process that routes a **Figma Command** to exactly one connected Figma plugin window.
_Avoid_: backend, proxy

**Daemon Client**:
The sole local interface to the **Bridge Daemon**, owning request signing, file targeting, timeouts, health and transport-error semantics.
_Avoid_: fetch helper, daemon wrapper

**Figma Target Context**:
The immutable resolution of exactly one plugin file for a **Figma Command**, including whether the file came from an explicit key, a Figma URL, or the single connected window.
_Avoid_: fileKey parameter, current window

**Asset Policy**:
The canonical classification of image fills, vector artwork and vector clusters shared by **Design Capture** projections and asset export. Node-side and plugin-side adapters apply the same policy implementation.
_Avoid_: vector heuristic, exporter rule

## Example dialogue

> **Developer:** Does `figma_spec` behave differently through MCP and the CLI?
>
> **Domain expert:** No. Both adapters invoke the same Command Application. It evaluates through the Daemon Client, and the Figma Command keeps one audit lifecycle.

> **Developer:** Where do I add a new command's write gate and timeout?
>
> **Domain expert:** Add one Command Capability. Adapters consume its resolved plan; they do not duplicate those decisions.

> **Developer:** Can structure and style share work without returning stale design data?
>
> **Domain expert:** Yes. They project the same Design Capture only while the Bridge Daemon connection and Figma document revision remain unchanged. Without revision evidence, capture runs again.

> **Developer:** Where should I change what counts as one exported SVG?
>
> **Domain expert:** Change the Asset Policy. The spec and exporter use the same implementation through different node adapters.

> **Developer:** Can a command silently switch to another open file?
>
> **Domain expert:** No. Its Figma Target Context resolves once, then accompanies the Command Capability, audit entry, job identity and Daemon Client call.
