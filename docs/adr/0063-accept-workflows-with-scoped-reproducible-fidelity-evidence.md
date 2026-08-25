# Accept workflows with scoped reproducible fidelity evidence

A representative Fidelity Corpus workflow can be accepted independently only
through a Workflow Fidelity Run. Its scorer selects exactly the cells assigned
to the named workflow, retains the same release thresholds and Evidence IDs,
and reports `WORKFLOW PASS` rather than implying that unrelated editor and
workflow coverage has passed the full release.

Every evidence row names a repository-contained artifact and its SHA-256
digest. Validation canonicalizes each artifact path, rejects escapes and checks
the bytes before scoring. Clean fixture inputs and the resulting typed Semantic
Render Plan are also digest-pinned so a changed input cannot inherit an older
live acceptance.

Figma Desktop remains a required supplement for native write, readback,
responsive and visual evidence. CI proves corpus completeness, deterministic
planning, fail-closed scoring and artifact integrity; it never fabricates the
desktop observations. Known normalized outcomes remain explicit, and any
unexpected approximation, unsupported fact or silent loss fails the scoped
acceptance.
