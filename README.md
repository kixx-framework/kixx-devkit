Kixx Devkit
===========

A developer tool-kit for Kixx applications.

CLI Commands
------------

The `kixx.js` CLI dispatches to commands in the `commands/` directory. See
[commands/README.md](commands/README.md) for how the command runner discovers
and configures commands, and what to write to add a new one.

Available workflows:

- `kixx.js app create-release` — create immutable application content.
- `kixx.js app assign-build` — assign an existing Release to a build.
- `kixx.js app publish` — create and assign application content.
- `kixx.js app rollback` — inspect or restore a build's content history.
- `kixx.js cloudflare create-worker` — create a Cloudflare Worker.
- `kixx.js cloudflare create-worker-version` — upload an undeployed Worker version.
- `kixx.js cloudflare deploy-version` — route traffic to an existing Worker version.
- `kixx.js cloudflare release` — stage content and deploy a Worker release.

See [create-release](docs/create-release.md),
[assign-build](docs/assign-build.md), [publish](docs/publish.md),
[rollback](docs/rollback.md), [create-worker](docs/create-worker.md),
[create-worker-version](docs/create-worker-version.md),
[deploy-version](docs/deploy-version.md), and [release](docs/release.md) for
usage and configuration.

Development
-----------

Run the linter over the project's JavaScript sources:

```
npm run lint
```

Run the unit test suite:

```
node run-tests.js
```

`run-tests.js` runs every `*.test.js` file under `test/unit-tests/`. Pass
pathnames to run a subset, or `--skip <path>` (repeatable) to exclude one:

```
node run-tests.js test/unit-tests/lib
node run-tests.js --skip test/unit-tests/lib/config-loader.test.js
```

Run both, linter first:

```
npm test
```

Copyright and License
---------------------
Copyright: (c) 2026 by Kris Walker (www.kriswalker.me)

Unless otherwise indicated, all source code is licensed under the MIT license. See LICENSE for details.
