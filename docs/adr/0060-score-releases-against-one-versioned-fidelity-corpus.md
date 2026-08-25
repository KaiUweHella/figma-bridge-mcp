# Score releases against one versioned bidirectional fidelity corpus

Figma Bridge uses one redistributable corpus and one fail-closed scorer for its
own release proof and for comparison implementations. Workflow facts declare
direction-specific structural, semantic, visual and operational targets before
a run. `exact`, `normalized`, `approximated`, `unsupported` and
`silently-lost` remain separate result classes; a declared platform limit can
meet its contract, but unexpected unsupported output and every silent loss
fail.

The first release profile requires complete observations and reproducible
Evidence IDs, 100% target conformance in every dimension and at most 1% visual
pixel difference. Comparison tools never redefine the fixture, expected facts
or thresholds. Missing access is reported as benchmark availability, not as a
fidelity result.
