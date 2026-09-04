# Agent instructions

## Agent skills

### Issue tracker

Implementation tickets are maintained as private local Markdown under `docs-local/issues/`; that directory is ignored by Git. See `docs/agents/issue-tracker.md`.

### Live acceptance fixtures

A fixture that reproduces one of the maintainer's real Figma files carries a
bare file key, component keys and real screen copy. Such fixtures and their
test files live under the Git-ignored `docs-local/evals/`, never in a tracked
path — `evals/roundtrip/` is ignored for that reason. `check:public-safety`
passing is not evidence that this content may be committed: diff the staged
content for file keys and personal names before any commit, and never
`git add -A` without reading the added-file list first.

What matters is the **file key** and any access key or token, because those
address and unlock a file. A bare node or slide id does not: `12:34` identifies
nothing without the file it belongs to, so real ids in docs, comments and test
fixtures are fine. Prefer placeholders in _illustrative_ examples anyway — an
example reads better when it is obviously an example — but do not treat a node
id as a secret.

Raw measurement logs, probe transcripts and handoff documents belong under
`docs-local/` (`docs-local/live-tests/`, `docs-local/handoffs/`): not because
node ids are sensitive, but because that material is session bookkeeping rather
than something the repository should carry.

### Triage labels

Use the canonical local triage vocabulary `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, and `wontfix`. After verified
implementation, the local lifecycle status is `completed`. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: read the root `CONTEXT.md` and the relevant decisions under `docs/decisions/` before changing a domain area. The full decision records with their context and evidence live in the maintainer-local `docs-local/adr/`; a new durable decision is recorded there and its current state is added to `docs/decisions/`. See `docs/agents/domain.md`.

### Release boundary

Agents may prepare and commit release changes locally. Never create or move a
release tag, push commits or tags, dispatch a publish workflow, or publish a
package unless the user explicitly authorizes that exact remote action in the
current request. The maintainer performs those release steps manually by
default.
