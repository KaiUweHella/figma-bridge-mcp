# ADR-0019: Own compound Semantic Render as one Command

Wrapper auto-split and explicit `render-batch` adapt into one closed Compound
Semantic Render Request. Commander, `figma_run` and typed `figma_render` build
the same authoritative Command Plan, resolve the same target, prepare before
readiness and retain one confirmation, deadline, Audit lifecycle and bounded
Semantic Render Outcome. Commander is never recursively re-entered.

The request owns a bounded ordered root set. Gap and direction govern placement
between roots; explicit x/y and smart positioning choose the batch origin.
Preset, collection, Registry manifest, icon source, fallback approvals and
free-layout allowances apply to every root. `--keep-wrapper` deliberately
selects the existing single-root path. Component conversion, resize probing
and verification are explicit stages rather than hidden Adapter behavior.

Every root, structured plan, local image, icon and Registry input is validated
before readiness where host data permits it. Local paths cross Workspace I/O;
remote image intent remains an explicit network effect and does not widen the
Plugin manifest. Native execution performs one structured batch using the
batch-wide mutation journal. Generated JavaScript is allowed only when native
capability rejection is proven before dispatch, never as a response to an
uncertain write.

Follow-up stages execute sequentially against the exact handles returned by the
preceding stage. Their response shapes and artifacts are closed and bounded.
A failed conversion, probe, verification, missing root, malformed envelope or
Structural Gate mismatch produces a non-success Outcome with the exact known
handles and mutation residue. It cannot recursively invoke another command,
select another executor or be audited as code-0 success.
