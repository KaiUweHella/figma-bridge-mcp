# ADR 0126: Own video export behind one bounded Command Application

`export video` already had a Command Plan with a Figma read and exact Workspace
output, but Commander still owned connection probing, option interpretation,
generated evaluation, Base64 trust and direct publication. `figma_run` reached
the same command through Commander fallback. The execution could therefore
diverge from its Plan, and the fixed URL projection missed valid Commander
forms where options precede the positional node.

Keep Figma's native `FrameNode.exportAsync()` formats and the documented MP4,
GIF and WebM interface. Introduce one closed Video Export request and one
Plan-bound Command Application shared by Commander and `figma_run`, with
fallback disabled. The request owns node or URL identity independent of option
order and preserves the legacy rule that format-inapplicable `--quality` or
`--loop` values are ignored. It rejects unknown, duplicate, malformed and
excess arguments before readiness. The Plan owns the exact `video-output`, uses
the long timeout class so migration does not narrow the former readiness plus
evaluation budget, and remains non-retrying because Workspace publication
follows the read.

The Plugin resolves the requested node to a top-level Frame in Figma Design and
applies only Figma's format-specific settings. Its canonical Base64 response is
bounded below both the generic 5 MB result ceiling and the 5 MiB Plugin-message
ceiling. The host requires exact requested/frame evidence and validates the
matching MP4 box topology, GIF signature/dimensions/terminator, or WebM
EBML/DocType/Segment markers before Workspace I/O. Invalid, mismatched or
oversized evidence publishes no bytes.

Do not widen or overload `asset-stream-v1`: ADR 0097 deliberately closes that
protocol to Figma image and SVG references. Videos above the existing generic
result budget require a separately versioned media-stream capability in a
future slice. This ownership migration changes neither Figma's export settings
nor the default policy and does not mutate the document.
