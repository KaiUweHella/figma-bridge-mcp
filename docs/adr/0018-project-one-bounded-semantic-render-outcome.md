# ADR-0018: Project one bounded Semantic Render Outcome

The simple Semantic Render Command Application returns one versioned Outcome.
The Plugin response is untrusted post-dispatch input and cannot reach an
Adapter until it passes a closed schema plus total byte, nesting, collection,
string, numeric and handle bounds. Unknown fields are protocol drift, not
forward-compatible success.

A completed Outcome contains only the created root handle, executor version,
planned and live structural facts, bounded resource decisions, overflow,
mutation facts and local notices. `completed-with-findings` preserves the
created root and maps to the Command Capability-owned accepted code `1`;
ordinary completion maps to `0`. CLI text, MCP structured content, JSON, YAML,
Audit completion and process outcome are deterministic projections of this
same value.

Failure Outcomes contain closed kind, phase, dispatch and mutation-residue
facts only. They never contain Plugin stacks, error prose, JSX, source payloads,
image bytes, file keys, credentials or argv. A malformed or oversized Plugin
response therefore remains `plugin-response` / `unknown-after-dispatch` and
cannot be formatted as a successful render. Known rollback facts supplement
that uncertainty; they do not authorize replay.
