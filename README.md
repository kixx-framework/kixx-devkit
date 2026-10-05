Kixx Devkit
===========

A developer tool-kit for Kixx applications.

Install
-------

Install the `kixx` command with Node.js 24 or later:

```
npm install -g kixx-devkit
```

Or with Deno 2.8 or later:

```
deno install -g -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx
```

The Deno permissions:

- `-R` read and `-W` write: project files, `.kixx` settings, and Cloudflare
  state files.
- `-N` net: the Cloudflare API and your application's Admin and Publishing
  APIs.
- `-E` env: prompt values such as `KIXX_ADMIN_PASSWORD`, and any variable your
  `cloudflare-config.js` reads.
- `--allow-sys=homedir`: locate the `~/.kixx` settings layer.

Subprocess (`--allow-run`) and FFI access are not granted. The CLI never needs
them, and it executes your project's `cloudflare-config.js`, so withholding
them limits what that code can do.

Upgrade:

```
npm install -g kixx-devkit@latest
deno install -g -f -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx
```

Verify the install:

```
kixx --version
```

CLI Commands
------------

The `kixx.js` CLI dispatches to commands in the `commands/` directory. See
[commands/README.md][commands-readme] for how the command runner discovers and
configures commands, and what to write to add a new one.

Available workflows:

- `kixx app create-release` — create immutable application content.
- `kixx app assign-build` — assign an existing Release to a build.
- `kixx app publish` — create and assign application content.
- `kixx app rollback` — inspect or restore a build's content history.
- `kixx cloudflare create-worker` — create a Cloudflare Worker.
- `kixx cloudflare update-worker` — replace a Worker's Worker-level configuration.
- `kixx cloudflare bootstrap` — create the Worker if missing and deploy its first version.
- `kixx cloudflare create-worker-version` — upload an undeployed Worker version.
- `kixx cloudflare set-secret` — create an undeployed version with one secret changed.
- `kixx cloudflare set-secrets` — atomically set additive secrets from dotenv input.
- `kixx cloudflare recover-secret-version` — repair state for a verified secret-only version.
- `kixx cloudflare delete-secret` — create an undeployed version without one secret.
- `kixx cloudflare deploy-version` — route traffic to an existing Worker version.
- `kixx cloudflare release` — stage content and deploy a Worker release.
- `kixx admin gen-secure-token` — generate a secure bootstrap token.
- `kixx admin accept-invite` — redeem an invite and create an admin account.
- `kixx admin create-publishing-token` — mint a Publishing API token.
- `kixx admin list-migrations` — list registered migrations and their status.
- `kixx admin run-migration` — run one bounded batch of a migration.

See [app.md][app-doc], [cloudflare.md][cloudflare-doc], [admin.md][admin-doc],
and [configuration.md][configuration-doc] for usage and configuration.

Publishing commands require an application serving Publishing API build
assignment protocol 2 and addressing format 4. Older deployments are refused
before any write; see [app.md][app-doc-server-requirement].

<!-- Absolute links so they resolve on npmjs.com and jsr.io as well. -->
[commands-readme]: https://github.com/kixx-framework/kixx-devkit/blob/main/commands/README.md
[app-doc]: https://github.com/kixx-framework/kixx-devkit/blob/main/docs/app.md
[app-doc-server-requirement]: https://github.com/kixx-framework/kixx-devkit/blob/main/docs/app.md#server-requirement
[cloudflare-doc]: https://github.com/kixx-framework/kixx-devkit/blob/main/docs/cloudflare.md
[admin-doc]: https://github.com/kixx-framework/kixx-devkit/blob/main/docs/admin.md
[configuration-doc]: https://github.com/kixx-framework/kixx-devkit/blob/main/docs/configuration.md

Development
-----------

Development uses Deno 2.8 or later. Releases also run the test suite on
Node.js 24 or later. Dev dependencies are pinned in `deno.json` and installed
into `node_modules/` on first use; there is no npm step.

Type-check the entry points:

```
deno task check
```

Run the linter over the project's JavaScript sources:

```
deno task lint
```

Run the unit test suite:

```
deno task test
```

`run-tests.js` runs every `*.test.js` file under `test/unit-tests/`. Pass
pathnames to run a subset, or `--skip <path>` (repeatable) to exclude one:

```
deno task test test/unit-tests/lib
deno task test --skip test/unit-tests/lib/config-loader.test.js
```

Run the unit test suite on Node.js (accepts the same arguments):

```
deno task test:node
```

Run the CLI from source, with the same Deno permissions an installed `kixx`
gets:

```
deno task kixx <command> <subcommand> [options]
```

Releasing
---------

`.github/workflows/release.yml` publishes to JSR and npm when a `v<version>`
tag is pushed. It authenticates with GitHub OIDC (no stored tokens), checks the
tag against both manifests, runs the checks below, and skips any registry that
already has the version, so re-running a failed release finishes it.

1. Set the same `version` in `deno.json` and `package.json`.
2. Run the local validation:
   ```
   deno task check && deno task lint && deno task test && deno task test:node
   ```
3. Commit, then tag and push the tag:
   ```
   git tag v<version>
   git push origin v<version>
   ```

Copyright and License
---------------------
Copyright: (c) 2026 by Kris Walker (www.kriswalker.me)

Unless otherwise indicated, all source code is licensed under the MIT license. See LICENSE for details.
