# Bidirectional fidelity corpus

Figma Bridge measures release fidelity against the versioned corpus in
`evals/fidelity/v1/`. The corpus and its assets are authored for this project,
MIT licensed and contain no customer design, private Figma file or proprietary
asset.

## What the score means

Every expected workflow fact declares a target independently for structural,
semantic, visual and operational fidelity. Outcomes use a closed vocabulary:

- `exact` preserves the same authored fact and parameters.
- `normalized` preserves meaning through a deterministic representation change.
- `approximated` is a declared, lower-fidelity representation.
- `unsupported` is an explicit platform boundary named by the corpus.
- `silently-lost` is always a release failure.

Scores measure conformance to the declared target, not optimistic feature
parity. For example, an explicitly unsupported Dev Mode design write can meet
its contract only when Bridge rejects it at the editor gate with reproducible
evidence. An unexpected unsupported result for a Design workflow fails.

The `release-v1` profile requires 100% target conformance in all four
dimensions, zero missing observations, zero silent loss, a 100% evidence pass
rate and at most 1% visual pixel difference. Known normalization is fixed in
the corpus before a run; a benchmark cannot relabel a regression after the
fact.

## Evidence and reproduction

Each observation resolves to registered Evidence IDs from the executable
Round-trip Fidelity Contract. Evidence records must point to a safe relative
artifact path and its SHA-256 digest. Visual observations additionally carry
the measured pixel-difference percentage. The scorer rejects missing,
duplicate, failed or over-tolerance evidence.

Run the static corpus gate with:

```sh
npm run check:fidelity-corpus
```

Score an implementation run with:

```sh
node scripts/validate-fidelity-corpus.js --run path/to/run.json
```

The v1 corpus covers native Auto Layout, responsive constraints, rich text,
component and variant identity, Variables and Aliases, ordered effects, masks,
source assets, prototype reactions and the supported `figma`, `figjam`,
`slides` and `dev` editor contexts. Live Figma evidence supplements CI where
the public Plugin API runtime is required.
