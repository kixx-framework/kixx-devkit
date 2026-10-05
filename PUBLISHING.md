Publishing
==========

How the `kixx` CLI is distributed, and how to publish a release.

**tldr;** To publish a new version, push a tag to GitHub origin starting with
`v*`. See [Publishing a Release](#publishing-a-release) below,
for the full runbook.

Distribution
------------

One source tree is published to two registries under the same version:

| Registry | Package          | Install                                                          | Runtime     |
|----------|------------------|------------------------------------------------------------------|-------------|
| npm      | `kixx-devkit`    | `npm install -g kixx-devkit`                                     | Node.js 24+ |
| JSR      | `@kixx/devkit`   | `deno install -g -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx` | Deno 2.8+   |

Both install an executable named `kixx`. npm gets the name from `bin` in
`package.json`. Deno names it after the last segment of the specifier, which is
why JSR exports the `./kixx` subpath.

The source is plain JavaScript using `node:` built-ins, so the same files run
on both runtimes. There are no runtime dependencies; third-party code is
vendored under `lib/vendor/`.

Two manifests describe the packages:

- `deno.json` is the source of truth: name, version, the JSR export, the JSR
  file list (`publish`), dev tool pins, and tasks.
- `package.json` is a minimal npm manifest: name, version, `bin`, and the npm
  file list (`files`).

The Release Workflow
--------------------

`.github/workflows/release.yml` runs only when a tag matching `v*` is pushed.
There is no CI on pushes or pull requests; validate locally before tagging.

Both registries authenticate with GitHub OIDC (`id-token: write`); no tokens
are stored in the repository. JSR trusts the repository linked in the
package's settings. npm trusts the trusted publisher configured for
`kixx-framework/kixx-devkit` and `release.yml`, and attaches a provenance
attestation automatically.

Because each publish step skips a version its registry already has, re-running
a workflow that failed partway finishes the release without republishing.

Actions are pinned to commit SHAs. Update them deliberately.

Publishing a Release
--------------------

### 1. Choose the version

Use semantic versioning. While the version is `0.x`, bump the minor version
for any breaking change to commands, flags, or configuration files, and the
patch version otherwise.

### 2. Bump both manifests

Set the same `version` in `deno.json` and `package.json`.

### 3. Validate locally

From a clean working tree:

```
deno task check && deno task lint && deno task test && deno task test:node
deno publish --dry-run
npm pack --dry-run
```

- `deno publish --dry-run` should succeed. The
  `unsupported-javascript-entrypoint` warning is expected.
- `npm pack --dry-run` should list only `kixx.js`, `commands/**`, `lib/**`,
  `deno.json`, `README.md`, `LICENSE`, and `package.json`.

### 4. Commit and merge to `main`

Commit the version bump and merge it to `main`. README links point at
`main`, so the docs on `main` should match the release.

### 5. Tag and push

Tag the release commit on `main` and push only the tag:

```
git tag v<version> <commit>
git push origin v<version>
```

### 6. Watch the workflow

In the repository's Actions tab, open the Release run for the tag. A good run
ends with:

- Publish to JSR: `Successfully published @kixx/devkit@<version>`
- Publish to npm: a `+ kixx-devkit@<version>` line and a provenance statement

If it fails:

- **Before any publish step** (version check, lint, tests): nothing was
  published. Fix the problem on `main`, then move the tag to the fixed commit
  (`git tag -f v<version> <commit>` and
  `git push -f origin v<version>`).
- **In a publish step** because of a registry or network problem: fix the
  cause (for example, the JSR repository link or the npm trusted publisher),
  then use "Re-run jobs". The registry that already has the version is
  skipped.
- **After a registry has the version** and the release itself is wrong: never
  move the tag. Registry versions are permanent. Fix it on `main` and release
  the next patch version.

### 7. Verify

```
npm view kixx-devkit@<version> version
curl -s https://jsr.io/@kixx/devkit/meta.json | jq .latest
```

Then install both into a scratch directory, not your global prefix, and run
`kixx --version`:

```
npm install -g --prefix /tmp/kixx-npm kixx-devkit
/tmp/kixx-npm/bin/kixx --version

deno install -g --root /tmp/kixx-deno -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx
/tmp/kixx-deno/bin/kixx --version
```

Registry Setup
--------------

This setup was done once, for 0.1.0. You need it again only to recreate the
packages or to repair trust settings.

- **JSR:** `@kixx/devkit` exists in the `@kixx` scope, and its Settings link
  the GitHub repository `kixx-framework/kixx-devkit`.
- **npm:** `kixx-devkit` has a trusted publisher (GitHub Actions,
  organization `kixx-framework`, repository `kixx-devkit`, workflow filename
  `release.yml`, no environment). npm only allows a trusted publisher on a
  package that already exists, so 0.1.0 was published by hand and has no
  provenance.
- **To do:** after the first release published to npm by the workflow,
  set the npm package's Publishing access to "Require two-factor
  authentication and disallow tokens".
- **Repository URL:** npm trusted publishing requires `repository.url` in
  `package.json` to match the GitHub repository. If an npm publish fails with
  a provenance or repository mismatch, check that field first.
