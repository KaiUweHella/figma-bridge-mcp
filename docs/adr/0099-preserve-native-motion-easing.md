# Preserve native Motion Easing without approximation

## Status

Accepted.

## Context

Figma Variables support `EASING` values as named and custom cubic Bézier
curves, named and custom springs, and `HOLD`. DTCG 2025 has a standard
`cubicBezier` type, while CSS timing functions cannot represent every native
Figma spring exactly. Treating the composite value as a generic string loses
its Variable type; serializing the object directly produces unusable output;
approximating a spring as a curve invents fidelity that the Bridge cannot
prove.

## Decision

Token capture, Variable Snapshot validation and Token Export share one native
Motion Easing contract. Every supported Figma value is canonicalized and
preserved in a versioned DTCG Bridge extension, including every Collection
mode and Alias identity.

Named and custom cubic Bézier values use the standard DTCG `cubicBezier` type
and an exact CSS timing function. `HOLD` remains a native value in the Bridge
extension and projects exactly to `steps(1, jump-end)` in CSS. Spring values
remain typed native values in DTCG, but CSS emits an explicit limitation
comment instead of an approximation or invalid declaration.

Token Import accepts standard DTCG cubic Bézier values as native custom Figma
EASING Variables. When the versioned Bridge extension is present, it restores
the original named or custom native variant. The normal DTCG importer supports
this lossless projection for its default/single-mode token model; complete
multi-mode Collection reconstruction remains the responsibility of Portable
Variable Snapshot.

## Consequences

Figma-to-code export no longer drops EASING objects or renders
`[object Object]`. Code-to-Figma can recreate every native easing variant from
Bridge-authored single-mode DTCG and interoperable cubic Bézier values from
standard DTCG. Unsupported CSS spring projection is visible to humans and
machines, and no apparently exact substitute is fabricated. Multi-mode native
round trips retain the stricter Snapshot path rather than weakening Token
Import's closed topology contract.
