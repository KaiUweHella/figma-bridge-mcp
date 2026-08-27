# Project URL targets from semantic fields

A Figma URL may derive a Figma Target Context only when it appears in a
Command Capability's closed semantic node field. The Capability Catalog owns
that projection before path normalization, confirmation, Audit, job identity,
or Adapter dispatch. It never searches the complete argv.

Every exposed command root is classified as either target-free or as a closed
set of positional/ranged/flag fields. URLs in text, JSX, names, annotations,
local paths, remote assets, labels, resource values, and unrelated option
values remain payload. Adding a command root without a projection contract is
catalog drift and stops startup.

Target precedence is explicit caller file, projected semantic Figma URL,
Design Link Registry, then implicit single-window targeting. An explicit file
therefore avoids interpreting URL fields. Without an explicit file, semantic
node URLs that name more than one file stop before confirmation or dispatch;
the Bridge never guesses which one should own a cross-file-looking request.

Node fields continue to accept canonical ids, dashed URL ids, full Figma URLs,
surrounding whitespace, and documented schemaless URL forms. A union field
that also accepts a user-authored name or label derives a target only from the
explicit `node:` variant defined by ADR 0080. `name:`, `label:`, `query:` and
unprefixed compatibility values remain payload. This keeps URL-shaped names
usable and preserves ordinary single-window workflows; users can always
provide the explicit file target when a command has no unambiguous URL-bearing
identity field.

Closed request Interfaces that share this syntax delegate to one internal Node
Reference Module. It owns the common bound, accepted bare/dashed/instance-path
forms, URL normalization, warning and file-target facts. Each Figma Command
still owns whether a node is required, its positional arity, options and error
prose. Canonical argv contains only the normalized node id; a URL survives only
as the planning value long enough to resolve the Figma Target Context.
