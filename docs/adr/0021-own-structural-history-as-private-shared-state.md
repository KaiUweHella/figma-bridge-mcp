# Own structural history as private shared state

Local structural history contains Figma-authored names, text, geometry,
component identities and properties. It is not a workspace artifact, but the
old command-level helpers accepted arbitrary existing host paths, followed
filesystem links, parsed unbounded gzip JSON and relied on the process umask
for file privacy. Moving snapshots into each repository would narrow normal
history workflows and mix private design facts with project output.

One Structural Snapshot Store therefore owns the exact local shared-state root
and exposes only `save`, `list`, `resolve`, `read` and display-only `directory`
operations. It maps ordinary Figma file keys unchanged and unusual keys to a
collision-resistant digest namespace. Reads require an opaque descriptor
created by the same Store instance; callers cannot provide a host path or
forge authority by copying descriptor fields.

The Store validates every directory and leaf as a non-symlink and rechecks
directory plus file identity around open, read and prune operations. New
directories are `0700`, new files are exclusively created as `0600`, and an
existing timestamp is never overwritten. Canonical UTC timestamps are the
only filenames. Listing count, compressed bytes, expanded bytes, nesting and
collection entries are bounded before parsed data reaches structural diffing.
Unexpected host errors are projected as path-free shared-state policy errors.

`latest`, `previous`, bounded numeric indices, exact filenames and unique
filename prefixes remain supported inside the owning file namespace. Existing
canonical snapshots remain readable through the same bounded path. Snapshot,
list, diff and changelog semantics do not move into Workspace I/O and do not
need project-write configuration. The history Command Adapter delegates this
whole persistence concern to the Store, keeping the security boundary local
and independently testable.
