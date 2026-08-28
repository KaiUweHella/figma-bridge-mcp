# Own Component Swap as a one-shot verified Command Application

## Status

Accepted.

## Context

`component swap` changes one existing Instance to an explicit Component, but
its legacy Commander Action owns target parsing, readiness, generated mutation
code and output. It performs no fresh readback. Figma preserves Instance
overrides through native matching heuristics, and those heuristics can alter
state during every swap. Swapping back therefore cannot prove restoration of
the complete pre-mutation Instance.

## Decision

Use one closed request for the Instance/URL target, Component/URL target and
output mode. CLI and MCP consume the same authentic, non-retrying
`component.swap` Command Plan and Command Application. Local and library-backed
Component targets remain available; the operation adds no restriction on
existing overrides.

Preflight resolves the exact Instance, requested Component and current main
Component. A request for the already active Component succeeds without a
mutation. Otherwise the Application performs exactly one native
`swapComponent` call, invalidates cached inventory facts and freshly resolves
the Instance and its main Component. Exact requested readback is success,
including a native acknowledgement error followed by proof of the desired
state. Every other outcome is reported as unchanged, unexpected partial
residue or unavailable verification.

The Application does not issue an automatic swap-back. A second heuristic
swap could further change overrides and would not constitute a truthful
rollback.

## Consequences

Agents and users retain the native Figma swap behavior, remote library targets
and override preservation semantics. Both Adapters now receive one approval,
one write at most and bounded fresh outcome evidence. Uncertain outcomes are
never retried or mislabeled as restored; recovery remains an explicit user or
agent decision informed by the reported current main Component.
