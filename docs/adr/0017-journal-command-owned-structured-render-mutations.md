# Journal Command-owned Structured Render mutations

Native single and batch Semantic Render execution uses one request-scoped
mutation journal. Before that journal can receive an entry, every plan in the
request passes structural validation plus a shared, mutation-free resource
preflight. The preflight resolves fonts and component handles, decodes embedded
image input, and models variable, collection and Text Style creation in one
in-memory catalog so cross-plan naming conflicts fail before a real Figma
resource or visible node is created.

After this boundary, only resources returned by a creation call made for the
current Command are journaled. Variables, collections, Text Styles and scene
nodes retain their short-lived removal handle; reused user and library
resources never enter the journal. Entries are removed in reverse creation
order on failure, which removes dependent nodes before their styles, variables
and collections. The journal is bounded by the validated Render Plan node and
transport limits and never stores JSX, credentials or image bytes.

Figma image hashes have no removal API. A materialized image therefore becomes
bounded `partial-residue` evidence if a later mutation fails. Cleanup failures
are reported the same way and retain the original execution error as the
primary failure. The four closed mutation outcomes are `no-mutation`,
`rolled-back`, `partial-residue` and `completed`; residue exposes only a stable
kind, handle and reason, capped at 50 entries.

These facts supplement rather than weaken Dispatch Receipt semantics. A known
Plugin failure can return its mutation report through the authenticated Daemon
and Client. Timeout, disconnect or loss of the terminal response remains
`unknown-after-dispatch`, because an intended rollback is not proof that the
Plugin reached it. Such a write is never replayed automatically.
