# Bound Semantic Render foundation preflight

## Status

Accepted.

## Context

Semantic Render inventories local Variable collections, Variables and Text
Styles before mutating the canvas. Those asynchronous Plugin API reads had no
internal deadline. If one never settled in a large file, the Plugin remained
health-responsive while its serialized eval chain stayed occupied forever.
The daemon eventually reported an unknown write outcome, and later eval-based
operations could neither proceed nor reconcile it.

## Decision

The structured renderer bounds the combined foundation-catalog preflight to 15
seconds. The deadline is owned inside the Plugin runtime and occurs before any
canvas mutation. A timeout returns a structured no-mutation failure; it is not
retried. Tests may inject a shorter deadline through a closed runtime-only
option, capped at the production limit.

Component Property Facts use the independent typed-read lane, as decided in
ADR 0119, so the diagnostic read needed after an unknown write does not wait on
the serialized eval chain.

## Consequences

A stalled catalog read can fail one render but cannot silently occupy the
Bridge's component-authoring path without a bounded result. Health and typed
reads remain diagnostically distinct from eval/write execution. The operation
still reports an unknown outcome if an outer transport fails after mutation;
the deadline does not weaken existing no-retry or reconciliation rules.
