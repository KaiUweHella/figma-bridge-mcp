# ADR-0012: Parse Tailwind configuration as data

## Status

Accepted.

## Context

Token import needs only a small projection of `theme` and `theme.extend`, but
the previous implementation dynamically imported the complete selected
`tailwind.config.*` module inside the engine process. Workspace confinement
limited which file could be selected; it could not limit filesystem, process,
environment or network access after JavaScript execution began.

Removing Tailwind configuration support would narrow a useful Code-to-Figma
workflow. Running the module in `vm` or a same-privilege child process would
retain an executable security seam rather than remove it.

## Decision

A Static Tailwind Configuration Adapter parses JS, CJS, MJS and TS source as
data. It accepts ordinary direct object exports, typed const exports and
`satisfies` forms. Imports are never resolved. Only token-bearing `theme` and
`theme.extend` fields are materialized; unrelated fields such as `content` and
`plugins` are syntactically discarded, so their presence remains compatible
without executing their expressions.

Token-bearing values must be literal objects, arrays, strings, finite numbers,
booleans or null. Functions, references, calls, spreads, computed properties
and template interpolation in those fields fail with an actionable Tailwind v4
CSS or W3C JSON migration path.

The workspace read is limited to 1 MiB. Parsing runs in a worker with a
one-second deadline, explicit V8 memory limits, a maximum nesting depth of 64
and at most 20,000 collection entries. The worker receives source text only,
an empty environment and no inherited execution arguments.

## Consequences

Static Tailwind token import stays available without host code execution.
Projects may keep dynamic plugins, content rules and other fields because the
Adapter does not need them. Dynamic expressions that produce the actual theme
tokens must be resolved by the project and exported as `@theme` CSS or W3C JSON
before import.

The Adapter intentionally implements a useful static subset instead of trying
to reproduce JavaScript or Tailwind's full configuration resolver. New syntax
is added only with data-only parsing and adversarial evidence.
