# Releasing to npm

Publishing is artifact-first. The repository never stores a long-lived npm
write token, and no custom REST client publishes packages. CI publishes the
same verified tarball it installed and tested; it never asks npm to repack the
checkout after verification.

## Before every release

Agents stop after a local release commit by default. Creating a tag, pushing a
commit or tag, dispatching this repository's publish workflow, and publishing
to npm are separate maintainer actions; each requires explicit authorization
for that exact remote action.

1. Finish code and live Figma checks before committing release metadata.
2. Synchronize the release version everywhere with
   `npm run sync:release-version -- <version>`. This updates the root package,
   engine, lockfile, Codex/Claude/Cursor manifests, GitHub marketplace tag
   pins, and both MCP runtime pins. Update `CHANGELOG.md` with the release date
   and contents; `npm run check:release` must pass without rewriting anything.
3. Install the locked development graph without lifecycle scripts, then run the
   deterministic tests and blocking runtime audit:

   ```bash
   npm ci --ignore-scripts
   npm test
   npm run check:audit
   ```

   `npm test` includes cross-client install contracts, workflow-routing evals,
   Plugin artifact drift, and the package inventory/reproducibility gate.

4. Build the release candidate:

   ```bash
   npm run build:package-artifact -- --output-dir release-artifact
   ```

   This compares the complete packed path list with
   `release/package-artifact-policy.json`, rejects unexpected executable bits
   and symlinks, normalizes the reviewed executable modes and gzip header
   across operating systems, requires two byte-identical packs, and writes
   `release-artifact/integrity.json` with artifact and inventory digests. A
   deliberate new runtime file must be added to the policy in the same reviewed
   change.

5. Install `release-artifact/package.tgz` into a fresh prefix and run
   `scripts/smoke-mcp-server.js` with the installed server and engine paths.
   The smoke uses a scratch home, generated credentials, and a temporary
   loopback port. It exercises MCP initialization, tool discovery, pairing,
   authenticated daemon startup, status, Plugin installation, and cleanup
   without a maintainer secret. It explicitly clears
   `FIGMA_BRIDGE_PROFILE`, rejects the checkout-only `Local Development`
   identity, and requires the released `Figma Bridge` manifest with its normal
   `3456–3460` port range. The installed lock is reduced to a sanitized
   `dependencies.json` containing exact production versions, canonical npm
   registry origins, and SHA-512 integrity; an install lifecycle script fails
   the gate. The CI pack job installs with `--engine-strict` on Node 18, the
   declared runtime floor. CI performs this automatically.
6. Commit, create the exact `v<version>` tag referenced by both GitHub
   marketplaces, and push the commit and tag. Never move an existing release
   tag: publish a new version instead.

The repository must be public before a provenance-bearing release, and
`package.json#repository.url` must exactly match its canonical GitHub URL.

An npm package name/version pair cannot be reused after publication. Check the
tag, package version, and packed file list before continuing.

## GitHub marketplace release contract

The public distribution path is the GitHub repository marketplace, not the
universal OpenAI or Claude plugin directories:

- `.agents/plugins/marketplace.json` installs the Codex plugin from the exact
  `v<version>` Git tag.
- `.claude-plugin/marketplace.json` installs the same exact GitHub tag through
  an explicit public HTTPS Git URL; do not make public installs depend on SSH
  keys or `known_hosts` state.
- Cursor consumes the portable Agent Plugin from that tagged repository.
- `.mcp.json` and `mcp.json` start `figma-bridge-mcp@<version>` exactly. Only
  the standalone MCP fallback documented in `README.md` follows `@latest`.

Publish the matching npm version before announcing the GitHub marketplace
release. Then smoke-test the documented install path in fresh Codex, Claude
Code, and Cursor sessions and confirm that all three skills and the local MCP
server load. Validators prove manifest shape; this client smoke test proves
cache copying, discovery, and process startup.

## Automated gates and maintainer attestations

Automated on every tested release candidate:

- public-history safety, type/contracts, protocol and Plugin checks;
- generated Structured Render Runtime drift;
- exact package inventory, executable-bit policy, and byte reproducibility;
- root runtime audit plus audit of the fresh installed-package dependency graph;
- scratch pairing and authenticated daemon startup;
- tag/version agreement, commit-pinned Actions, npm OIDC publishing and
  provenance;
- retention of the tarball, `integrity.json`, and installed
  `dependencies.json` as a workflow artifact.

The maintainer still attests what CI cannot prove:

- live Figma Desktop round trips for the changed product paths;
- version/changelog correctness and the intent to publish that exact tag;
- fresh Codex, Claude Code, and Cursor discovery after publication;
- npm Trusted Publisher configuration and account security.

Runtime advisories block CI and release. `npm run check:audit:development`
reports development-only advisories separately. They are triaged and become
blocking when the affected package executes in the build/release path; they do
not automatically equate to code shipped to MCP users.

## First publication (maintainer runs locally)

Trusted Publishing can only be configured after the package exists. The first
release is therefore an explicit maintainer operation:

```bash
npm login
npm ci --ignore-scripts
npm test
npm run check:audit
npm run build:package-artifact -- --output-dir release-artifact
mkdir package-smoke
npm install --prefix package-smoke ./release-artifact/package.tgz --ignore-scripts
node scripts/smoke-mcp-server.js package-smoke/node_modules/.bin/figma-bridge-mcp package-smoke/node_modules/figma-bridge-mcp/engine/src/index.js
npm audit --prefix package-smoke --omit=dev
node scripts/write-installed-dependency-evidence.js package-smoke release-artifact/dependencies.json
npm publish ./release-artifact/package.tgz --ignore-scripts --access public
```

`publishConfig.access` makes the unscoped package public. The explicit
commands replace package lifecycle hooks because the verified tarball excludes
maintainer scripts and is intentionally published with `--ignore-scripts`.
Local first publication does not claim CI provenance.

After the package exists, configure the GitHub workflow as its Trusted
Publisher. Publishing through OIDC needs npm 11.5.1 or newer; the `npm trust`
configuration command itself needs npm 11.15.0 or newer and account-level 2FA:

```bash
npm trust github figma-bridge-mcp \
  --repo KaiUweHella/figma-bridge-mcp \
  --file publish.yml \
  --allow-publish
```

Confirm the exact repository and workflow filename in npm before accepting the
prompt. Then restrict or revoke traditional npm publish tokens.

## Later publications

Once the Trusted Publisher exists, the maintainer still chooses every release:

```bash
gh workflow run publish.yml -f tag=v0.4.1
gh run watch
```

The manual workflow checks out the supplied tag, refuses a tag/version
mismatch, installs dependencies without lifecycle scripts or a release cache,
runs all tests and audits, creates two identical packs, installs and smokes the
candidate, retains its integrity evidence, and publishes that exact tarball.
npm authenticates the specific GitHub workflow through OIDC and creates
provenance automatically. No `NPM_TOKEN` secret is involved.
