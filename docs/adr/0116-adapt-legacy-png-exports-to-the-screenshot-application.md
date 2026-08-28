# Adapt legacy PNG exports to the Screenshot Command Application

The documented `export node` and `export screenshot` names duplicated Plugin
capture, Base64 decoding, Workspace persistence and dimension projection that
the completed Screenshot Command Application already owns. The duplicate path
trusted logical geometry as output dimensions and bypassed bounded PNG
validation plus Plan-owned Verification Artifacts.

Keep both command names as compatibility aliases. A closed Raster Export
Compatibility request owns their node, scale, format and output fields. PNG
requests from CLI and MCP adapt to the Screenshot Command Application before
readiness, use its single bounded Plugin capture, validate signature and IHDR,
persist the exact Command Plan output through Workspace I/O, and report pixel
dimensions from the PNG separately from logical geometry. The alias retains
its established workspace filename and human-readable success output.

JPG, SVG and PDF remain useful documented outputs but are not PNG verification
evidence. They stay on one explicit non-PNG compatibility branch for this
release instead of being silently removed or mislabeled as Screenshot
Application output. Their normalized output extension and Workspace path are
still planned before dispatch. A future format-appropriate Application may
migrate them without changing these public names.

This removes the duplicate PNG implementation without narrowing normal export
utility or pretending that vector/document bytes have raster pixel facts.
