# Issue tracker: private local Markdown

Implementation tickets and working plans for this repository live under
`docs-local/`. This directory is ignored by Git and must remain private unless
the maintainer explicitly approves publishing selected material.

## Conventions

- The ticket index is `docs-local/issues/README.md`.
- Tickets are grouped by the North Star pillar they advance: security,
  stability, bidirectional fidelity, efficiency, or maintenance.
- Each ticket is a separate Markdown file with a stable pillar prefix and
  number.
- Triage state is recorded as a `Status:` line near the top of each ticket.
- `Type: AFK` means an agent can implement the accepted ticket without further
  product decisions. `Type: HITL` requires the named human decision or review.
- Dependencies refer to the stable local ticket identifier.
- Comments or investigation notes are appended under `## Notes`.

## When a skill says “publish to the issue tracker”

Create or update the corresponding file under `docs-local/issues/`. Do not use
GitHub Issues, another remote tracker, or a public repository file without
explicit maintainer approval.

## When a skill says “fetch the relevant ticket”

Read the referenced ticket file and the index. Also read `CONTEXT.md` and any
ADRs cited by the ticket before implementation.
