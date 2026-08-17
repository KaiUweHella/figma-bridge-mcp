# Releasing to npm

Publishing is CLI-first. The repository never stores a long-lived npm write
token, and no custom REST client publishes packages.

## Before every release

1. Finish code and live Figma checks before committing release metadata.
2. Synchronize the release version everywhere with
   `npm run sync:release-version -- <version>`. This updates the root package,
   engine, lockfile, Codex/Claude/Cursor manifests, GitHub marketplace tag
   pins, and both MCP runtime pins. Update `CHANGELOG.md` with the release date
   and contents; `npm run check:release` must pass without rewriting anything.
3. Run `npm test` and `npm pack --dry-run --json`. The test command also
   validates the cross-client install contract and workflow-routing evals.
   Inspect the tarball list for
   `src/`, `engine/src/`, all three plugin files, `README.md`, `SECURITY.md`,
   `CHANGELOG.md`, `NOTICE`, and both licenses. Confirm that repository-only
   material (`docs/`, `evals/`, `scripts/`, `tests/`, `CONTEXT.md`,
   `CONTRIBUTING.md`, `SUPPORT.md`) is absent.
4. Install the packed artifact in a temporary directory and run
   `node_modules/.bin/figma-bridge-mcp < /dev/null` followed by
   `node node_modules/figma-bridge-mcp/engine/src/index.js --help` there. This
   proves both the public executable and packaged command graph start without
   resolving files from the checkout; the CI `pack` job performs the same smoke
   test.
5. Commit, create the exact `v<version>` tag referenced by both GitHub
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
- `.claude-plugin/marketplace.json` installs the same exact GitHub tag.
- Cursor consumes the portable Agent Plugin from that tagged repository.
- `.mcp.json` and `mcp.json` start `figma-bridge-mcp@<version>` exactly. Only
  the standalone MCP fallback documented in `README.md` follows `@latest`.

Publish the matching npm version before announcing the GitHub marketplace
release. Then smoke-test the documented install path in fresh Codex, Claude
Code, and Cursor sessions and confirm that all three skills and the local MCP
server load. Validators prove manifest shape; this client smoke test proves
cache copying, discovery, and process startup.

## First publication (maintainer runs locally)

Trusted Publishing can only be configured after the package exists. The first
release is therefore an explicit maintainer operation:

```bash
npm login
npm publish --access public
```

`publishConfig.access` makes the unscoped package public, and
`prepublishOnly` runs the full test suite again. Local first publication does
not claim CI provenance.

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
mismatch, installs dependencies without a release cache, runs all tests, and
invokes `npm publish`. npm authenticates the specific GitHub workflow through
OIDC and creates provenance automatically. No `NPM_TOKEN` secret is involved.
