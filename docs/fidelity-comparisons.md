# Fidelity comparison baselines

Figma Bridge compares its accepted v1 fidelity corpus with three reference
implementations without adopting their architecture or turning source claims
into release scores. The machine-readable snapshot is
`evals/fidelity/v1/comparison-baselines.json`.

## Evidence levels

- `executable` means local tests bind every Bridge corpus direction to a
  registered Evidence ID. Only this level can produce a Bridge regression.
- `source-audited` means an exact upstream release archive and revision were
  inspected. It describes declared capability, not a successful corpus run.
- `docs-audited` means an immutable dated snapshot of official documentation
  supports the claim. A managed service without a public version is never
  assigned an invented server revision.

Product limitations, unavailable client or plan access, and missing evidence
are separate classes. An unavailable official client does not count as an
unsupported product feature. Conversely, a feature absent from a pinned source
release is not excused as an access problem. Only a run conforming to the
Fidelity Run schema can be scored by the release scorer.

## Audited configurations

The historical CLI is assessed only through its documented built-in Safe Mode
Plugin. Host modification and browser-debugging transports were neither enabled
nor installed. The community MCP was inspected from its pinned source archive;
its separate Plugin and credentials were not introduced into the Bridge test
environment. The official Figma MCP was documentation-only because the current
client did not expose a supported connection.

Useful behavior is translated into a Bridge requirement before implementation.
Existing sparse-first reads reinforce the current discovery-versus-exact-Facts
boundary, and safe Plugin operation reinforces Bridge's single authenticated
write authority. A newly observed bounded MCP response-provenance marker is
recorded in the private backlog, outside the active North Star release gate.

Validate the snapshot with:

```sh
npm run check:fidelity-comparisons
```
