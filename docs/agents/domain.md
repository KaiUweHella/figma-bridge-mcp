# Domain documentation

This is a single-context repository.

## Before exploring or changing code

1. Read the root `CONTEXT.md` for the project’s domain language.
2. Read the ADRs under `docs/adr/` that touch the area being changed.
3. Read any maintainer-local plan referenced by the active ticket.

If one of these sources is absent, continue without proposing documentation
solely to fill the gap.

## Use the project vocabulary

Issue titles, implementation plans, tests, and architectural descriptions use
the terms defined in `CONTEXT.md`, including Figma Command, Command
Application, Command Capability, Command Plan, Bridge Daemon, Daemon Client,
Figma Target Context, Design Capture, and Design Entity.

Do not silently introduce synonyms for defined concepts. If a required concept
is genuinely missing, record the vocabulary gap for maintainer review.

## Respect architectural decisions

Surface any conflict with an ADR explicitly. In particular, do not add a
second live-document transport, private Figma APIs, CDP patching, implicit
multi-file targeting, or retries of writes with an uncertain outcome unless a
new accepted ADR replaces the existing decision.
