# Preserve CSS raster layout with native Image structure

Browser DOM Capture resolves same-origin raster files only beneath the explicit
Design Link project root. The host verifies the file signature, reads bounded
intrinsic dimensions from PNG, JPEG, GIF or WEBP headers without decompressing
untrusted pixels, and carries those dimensions with the embedded asset. The
Plugin receives bytes and dimensions but gains no filesystem or network
authority.

CSS `object-fit: fill` maps directly to a native Figma Image paint in `FILL`
mode. Centered `contain` maps to `FIT`, and centered `cover` maps to `CROP`.
Those direct mappings remain editable and use Figma's native image semantics.

Figma's direct Image paint modes do not expose every CSS placement decision.
For `none`, intrinsic `scale-down`, or non-centered `contain`/`cover`, the
Bridge creates a clipped Frame with the measured CSS box and one absolute,
aspect-correct native Image child. The child retains the computed size and
offset; the Bridge does not invent an opaque crop-transform convention.

Simple keyword, percentage and pixel object positions are exact. More complex
CSS position expressions remain visible through a bounded native Figma
fallback annotation and use a centered reviewed fallback rather than silently
claiming fidelity. Structural Gate approval is scoped to the exact wrapper
paths created by this strategy.

Visual verification and native-property readback are both required. A correct
screenshot alone does not prove that an editable Image paint and its clipping
structure survived.
