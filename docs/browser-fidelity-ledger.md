# Browser fidelity ledger

`verify-build` can gate Figma-to-code acceptance on individual source facts,
not only asset references or a whole-image diff. A reviewed ledger maps every
important Figma fact to one deterministic target in a Browser DOM Capture.

Run the gate with both files:

```sh
figma-bridge-engine verify-build ./project \
  --fidelity-ledger ./fidelity-ledger.json \
  --browser-capture ./browser-capture.json \
  --json
```

The capture should come from `render --print-browser-capture`. It includes
computed CSS, authored layout intent, stable Design Entity attributes when the
application provides them, and font-face availability from the browser's Font
Loading API.

Complete captures use a dedicated hard input envelope of 32 MiB and 500,000
JSON structure entries. This accommodates composed screens with full computed
style evidence without weakening the generic workspace JSON policy.

## Ledger contract

```json
{
  "schemaVersion": 1,
  "sourceRootNodeId": "155:7710",
  "facts": [
    {
      "id": "hero.orb-two.blend",
      "sourceNodeId": "155:7818",
      "target": { "path": "screen/hero/orb.orb-two" },
      "property": "style.mixBlendMode",
      "expected": "screen"
    },
    {
      "id": "delivery.heading.family",
      "sourceNodeId": "155:8200",
      "target": { "entity": "screen.delivery.heading" },
      "property": "style.fontFamily",
      "expected": "Manrope"
    },
    {
      "id": "delivery.heading.loaded",
      "sourceNodeId": "155:8200",
      "target": { "entity": "screen.delivery.heading" },
      "property": "font.loaded",
      "expected": true
    }
  ]
}
```

Targets use exactly one of:

- `entity`: the preferred stable `data-figma-entity` identity;
- `path`: the capture path formed from class names, ARIA label, or tag name;
- `occurrence`: a one-based disambiguator when a path intentionally repeats.

Supported facts include node presence, computed or authored capture styles,
width/height, and loaded-font evidence. Computed CSS lets token-backed values
pass without requiring a literal source string.

Every fact receives exactly one result:

- `matched` — browser evidence equals the reviewed expectation;
- `approved-deviation` — it differs, but the ledger carries a non-empty review
  reason;
- `missing` — the target is absent/ambiguous, the property is unavailable, or
  the value differs.

Any `missing` fact makes `verify-build` exit with code 1. The contract is
bounded to 500 facts and rejects unknown properties, malformed identities,
ambiguous targets, and empty deviation reasons.
