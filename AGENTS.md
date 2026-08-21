# Agent instructions

## Agent skills

### Issue tracker

Implementation tickets are maintained as private local Markdown under `docs-local/issues/`; that directory is ignored by Git. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical local triage vocabulary `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, and `wontfix`. After verified
implementation, the local lifecycle status is `completed`. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: read the root `CONTEXT.md` and relevant decisions under `docs/adr/` before changing a domain area. See `docs/agents/domain.md`.
