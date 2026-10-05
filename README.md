Kixx Devkit
===========

A developer tool-kit for Kixx applications.

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

Copyright and License
---------------------
Copyright: (c) 2026 by Kris Walker (www.kriswalker.me)

Unless otherwise indicated, all source code is licensed under the MIT license. See LICENSE for details.
