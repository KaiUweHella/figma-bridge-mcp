# Public documentation

This directory carries the documentation a user of Figma Bridge needs beyond
the README:

- [`figma-plugin-api-coverage.md`](figma-plugin-api-coverage.md) describes the
  supported public Figma Plugin API surface and its boundaries.
- [`runtime-compatibility.md`](runtime-compatibility.md) states the Node.js
  and Figma runtime versions the Bridge supports.
- [`css-figma-semantic-matrix.md`](css-figma-semantic-matrix.md) documents
  Code-to-Figma conversion fidelity: which CSS facts map to which native Figma
  facts.
- [`browser-fidelity-ledger.md`](browser-fidelity-ledger.md) documents the
  per-source-fact Figma-to-browser acceptance gate that `verify-build` runs.
- [`slides-roadmap.md`](slides-roadmap.md) separates supported Slides work from
  current public-API limitations.

Architecture decisions, release and acceptance procedures, evidence corpora,
agent working conventions, backlogs and live-acceptance records are kept in
the maintainer's ignored `docs-local/` workspace. They are not part of the
published source or the npm package.
