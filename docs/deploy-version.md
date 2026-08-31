Deploy a Worker Version
=======================

`kixx.js cloudflare deploy-version` routes all traffic to an existing
Cloudflare Worker version. It supports promoting an uploaded version and
rolling back to an older version without creating new code.


Usage
-----

```
node kixx.js cloudflare deploy-version -e <environment> [version-id]
```

When `version-id` is omitted, the command uses `versionId` from
`.kixx/cloudflare-state.<environment>.json`.

Options:

- `--environment`, `-e` — required Cloudflare environment.
- `--force` — deploy when this checkout has no record that the version's
  content was published.


Content Safety Guard
--------------------

The command reads the selected version from Cloudflare and finds its
plain-text `BUILD_ID` binding. It then checks
`.kixx/app-state.<environment>.json` for a publish record for that build.

Without published content, the deployed Worker cannot open its content
snapshot and every request fails. The command therefore refuses deployment and
prints the exact `app publish --build-id` command needed to publish it.

A fresh checkout may not contain a publish record even when another checkout
published the content. Use `--force` only after confirming that the build is
available through the Publishing API.


State and Output
----------------

Cloudflare receives a percentage deployment assigning the selected version
100% of traffic. After Cloudflare accepts it, the command writes the version's
`BUILD_ID` and deployment time to `.kixx/app-state.<environment>.json`. A later
`app publish` uses that live build when `--build-id` is omitted.

If version lookup or deployment fails, application state is not changed.
