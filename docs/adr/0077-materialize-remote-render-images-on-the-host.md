# Materialize remote Render images on the host

Remote image URLs in Semantic Render input are source references, not Plugin
capabilities. The host must resolve every approved HTTP(S) image to bounded,
verified raster bytes before Plugin readiness and before any Figma mutation.
The Figma Plugin remains restricted to the authenticated localhost Bridge and
never receives a remote URL.

Remote sources require an exact configured origin. Public origins require
HTTPS; intentional private and loopback origins use a separate configuration.
Every redirect is reauthorized, all DNS answers must match the configured
public/private scope, and the connection is pinned to one approved address
while retaining the approved HTTP Host and TLS server identity. Compressed
responses, deadline or size violations, unsupported raster bytes and MIME
mismatches fail before dispatch.

Accepted PNG, JPEG, GIF and WebP inputs become the same `embedded-raster`
Semantic Render Plan asset used for workspace images. The asset carries
intrinsic dimensions, SHA-256 content identity and bounded source provenance.
Signed query strings may be used for retrieval, but only the credential-free
origin and path can survive preparation. Exact repeated references are loaded
once per Command, while equal bytes from different sources share content
identity without erasing their distinct provenance.

Image-bearing single renders, wrapper auto-split and explicit batches use the
compound Command Application so preparation, confirmation, deadline, Audit,
targeting and mutation journal remain one lifecycle. Guaranteed previews run
I/O-free structural validation only: they neither fetch a remote source nor
materialize workspace bytes. Raw `remote-raster` assets and generated
`createImageAsync(URL)` compatibility code are not executable fallbacks.

The content-neutral bounded Host HTTP reader is shared with Remote Storybook,
but each caller retains its own exact-origin configuration, accepted media and
response validation. This shares the security mechanics without coupling two
different domain policies.
