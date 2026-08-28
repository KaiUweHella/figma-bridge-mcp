# Enforce platform-native Private State permissions

Figma Bridge stores authentication credentials, audit records, structural
history, offline API material and one-shot transfers below one private Shared
State root. Command-owned Verification Artifacts use separately validated
temporary directories. POSIX mode bits already provided direct `0700`/`0600`
evidence, but Node reports synthesized Unix bits on Windows; those values did
not prove the effective DACL inherited from the user profile.

One Private State Permissions Module now owns that platform distinction. On
macOS and Linux it preflights one bounded tree without following links, opens
each exact inode and repairs plus verifies directories as `0700` and files as
`0600`. On Windows it invokes one packaged PowerShell Adapter through a fixed
argument array with no shell, bounded traversal, output and deadline. The
Adapter rejects reparse points, disables inheritance on each existing entry,
repairs the tree and verifies Full Control for exactly the current account,
LocalSystem and built-in Administrators. Those latter two principals already
have host-level authority and remain outside the local unprivileged-attacker
boundary, as does arbitrary code running as the current account.

Only closed ownership kinds are admitted. Shared State must be the exact
`.figma-bridge-mcp` root. A Verification Artifact root must already satisfy the
Command Plan's direct-child `figma-bridge-verify-*` namespace. The Module never
accepts a profile parent, filesystem root, Workspace output, general temporary
directory or a common ancestor derived from configured paths. Maintainer test
overrides outside Shared State are not silently claimed and repaired.

Normal startup repairs legacy permissive state idempotently before reading a
credential. Newly created Windows descendants inherit only the three allowed
Full-Control entries; existing descendants receive direct repaired evidence on
the next enforcement. Failure returns bounded recovery guidance without a host
path, user SID or PowerShell output. Correctly configured profiles add no
prompt, configuration or reduced Figma-to-code/Code-to-Figma capability.
