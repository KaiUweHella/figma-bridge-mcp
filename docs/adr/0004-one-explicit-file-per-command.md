# Target one Figma file per command

A single connected window may be implicit, but multiple windows require an explicit Figma Target Context. A full Figma URL supplies its file only from a Command Capability's closed semantic target field; payload argv is never searched. There is no all-files write because convenience fan-out would turn a targeting mistake into cross-file mutation; job identity and audit therefore include the resolved file key.
