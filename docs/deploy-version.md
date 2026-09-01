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
- `--force` — deploy without checking the version's `BUILD_ID` through the
  Publishing API.

Unless `--force` is used, configure
`app.environments.<environment>.origin` in `.kixx/config.json` and
`app.environments.<environment>.publishingToken` in `.kixx/secrets.json` for
the Publishing API guard. Cloudflare credentials remain
`cloudflare.accountId` and `cloudflare.apiToken` in `.kixx/secrets.json`.


Content Safety Guard
--------------------

The command reads the selected version from Cloudflare and finds its
plain-text `BUILD_ID` binding. It then checks the Publishing API build pointer
for that id.

Without an assigned Release, the command refuses deployment. Create and stage
content with `app publish --build-id <build-id>` or assign an existing Release
with `app assign-build` before retrying.

Use `--force` only when the Publishing API is unavailable or the build pointer
has been independently verified. The command records that the guard was
bypassed in its output.


State and Output
----------------

Cloudflare receives a percentage deployment assigning the selected version
100% of traffic. After Cloudflare accepts it, the command updates the
version's deployment status in `.kixx/cloudflare-state.<environment>.json`.
Publishing API discovery and build pointers remain authoritative for content
and running-build decisions.

If version lookup or deployment fails, Cloudflare state is not changed.
