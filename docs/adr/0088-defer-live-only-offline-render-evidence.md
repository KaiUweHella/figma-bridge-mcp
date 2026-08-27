# Defer live-only offline Render evidence

The Structural Gate runs before Plugin readiness and therefore cannot prove
facts owned by the connected Figma document. Treating an explicit Variable
reference without a literal fallback as either resolved or failed made this
offline audit claim evidence it did not have.

Every offline structural check now reports `PASS`, `FAIL` or `DEFERRED`.
Locally provable contradictions still fail the whole report. A live-only fact
is deferred and makes an otherwise successful report visibly deferred; it is
never described as resolved. The native Figma executor remains authoritative
for exact Collection and Variable resolution and continues to reject missing,
ambiguous or unsupported explicit intent before its first canvas write.

Semantic JSX prop discovery is generated from the same closed per-element
grammar used for validation. Reviewed aliases and typo suggestions may target
only a property valid for the addressed element. One offline
`render --prop-reference <element>` projection exposes that bounded grammar
without authorizing workspace, network or Plugin effects.

This preserves useful repository-only planning without weakening live
acceptance or teaching agents the authoring language through failed writes.
