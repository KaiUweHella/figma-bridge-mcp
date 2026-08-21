# ADR-0011: Confine workspace I/O without narrowing workflows

## Status

Accepted.

## Context

Figma Commands legitimately read source assets, tokens, Storybook indexes,
Design Link registries and build output, and write extracted design facts,
contracts, maps, screenshots and exported assets. Making paths absolute fixed
the engine working-directory mismatch, but did not stop traversal, absolute
escapes or symlinks that resolve outside the user's project. A blanket ban on
external projects would also break legitimate monorepo and multi-project work.

## Decision

The MCP launch directory is the automatic workspace root. Additional roots are
explicitly additive through `FIGMA_BRIDGE_EXTRA_ROOTS`, using the platform path
list separator. The Capability Catalog continues to normalize every supported
path and now sends its declared path roles through one Workspace I/O Module
before execution.

The engine receives the same canonical roots. Security-sensitive reads and
writes reopen paths through that Module, validate the opened inode after
symlink resolution, and only then transfer bytes. New parent directories are
created one component at a time with containment repeated after each step.
This detects a parent replaced by a symlink before output bytes can escape.

Whole-file text and JSON inputs default to 8 MiB, binary inputs to 64 MiB,
structured nesting to 64 levels, collections to 100,000 entries and YAML alias
expansion to 50 aliases. Narrower formats such as render images and SVG icons
retain their smaller format-specific limits.

Errors name a stable Command Capability path role, not the rejected absolute
path. Raw paths remain absent from the Audit Trail.

## Consequences

Normal work inside the launched project remains zero-configuration. A monorepo
parent can be the launch root, or separately located repositories can be added
explicitly. Existing command and render semantics remain available; only
undeclared filesystem reach is removed.

Workspace confinement does not defend against arbitrary code already running
as the same OS user, and it does not make remote URL fetching safe. Those are
separate boundaries.
