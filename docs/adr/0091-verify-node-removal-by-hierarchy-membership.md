# Verify Node removal by hierarchy membership

Figma can keep `getNodeByIdAsync()` handles readable after structural removal.
A non-null direct lookup is therefore not proof that a Node is still visible,
and a null lookup is not required to prove that removal succeeded.

`node delete` now uses one closed Node Deletion request and one non-retrying
Command Application shared by Commander and `figma_run`. It resolves every
bounded Node Reference before the first write. A handle is attached only when
its observed parent currently contains its id; missing and already-detached
handles are explicit non-mutating outcomes. Attachment requires every bounded
parent membership to reach the DOCUMENT root, so a child retained inside an
already-detached Component Set remains detached as well. Duplicate references
and cross-file batches fail before confirmation or readiness.

Attached targets are sorted by current ancestry depth so a supported batch may
delete both a child and its ancestor without the ancestor operation turning the
child into a misleading detached result. After each `remove()`, the Application
reads the captured former parent's current children. It reports `removed` only
when that membership is absent. It never repeats a write, retries the mutation,
or treats a retained direct handle as a failed deletion. If a later target
fails or cannot be verified, the error includes the number of earlier removals
that were already confirmed instead of hiding irreversible partial effects.

An explicit `node tree` root uses the same attachment definition. DOCUMENT is
the hierarchy root; every other direct target must have a complete parent chain
whose members currently list each child id. A detached direct handle is rejected with an actionable message
instead of being rendered as an ordinary canvas subtree. Other reconciliation
reads may expose detached state deliberately, but must not equate direct-id
availability with canvas membership.
