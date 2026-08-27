# Use one closed Render image-reference projection

Semantic Render must classify and prepare image references from one closed
attribute projection. `src` and `image` accept literal quoted or braced values;
they do not evaluate JavaScript expressions. The same projection feeds request
routing, Workspace I/O effects and the Semantic Render Plan.

Literal workspace PNG, JPEG, GIF and WebP paths resolve through Workspace I/O
under its configured roots and byte limits. Equal source references are read
once per Command, while equal verified bytes share one SHA-256 content identity.
`Image` nodes and image-bearing `Frame` nodes both carry that
`embedded-raster` asset into the plan and become native editable Figma IMAGE
paints without changing their requested node semantics.

HTTP(S), `data:` and existing `imgref:` values remain explicit policy routes;
they are never reinterpreted as workspace paths. Empty values, runtime
expressions, missing or outside-workspace files, oversized content, unsupported
formats and byte/type mismatches fail before Plugin readiness and before Figma
mutation.

This projection replaces independent classification and replacement regexes.
Adding another supported syntax therefore requires extending the closed parser
and its security tests once, not introducing an Adapter-specific path resolver.
