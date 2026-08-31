# Cloudflare release

`kixx.js cloudflare release` creates Worker code when needed, publishes the
content that code will serve, and only then routes traffic to it.

## Usage

```sh
kixx.js cloudflare release --environment production
```

Options:

| Option | Meaning |
| --- | --- |
| `--environment`, `-e` | Required environment in both Cloudflare and application configuration. |
| `--force` | Create a Worker version even when its recorded inputs are unchanged. |
| `--verbose` | List every content resource, hash, size, and disposition. |
| `--origin` | Override the environment's configured Publishing API origin. |
| `--token` | Override the environment's configured publishing token. The token is never printed. |

The command uses the Cloudflare configuration and secrets documented in
[`create-worker-version.md`](create-worker-version.md), plus the application
origin and publishing token documented in [`publish.md`](publish.md).

## Release phases

A normal code release has three ordered phases:

1. Create a Worker version without deploying it. The version receives a new
   `BUILD_ID` binding.
2. Publish the complete content closure under that exact build id.
3. Deploy the version to 100% of traffic and record its build as live.

Publishing must precede deployment. A Kixx application opens its content
snapshot through `BUILD_ID`; deploying first would make every request fail
until that build had a registered closure. Blob uploads remain inert until the
closure commits, so a failed publish does not alter the site currently serving
traffic.

The command reports each phase separately and in execution order.

## Version outcomes

Version creation can produce three outcomes.

### Created

Changed code, bindings, configuration, a Worker retarget, or `--force` creates
a version. Release publishes under the new version's `BUILD_ID`, then deploys
that version. A new build needs its own closure even when every resource blob
already exists; in that case publishing uploads nothing and commits the full
closure.

### Skipped

When Worker inputs are unchanged, release creates no version. It publishes
content onto the build already recorded as live and performs no deployment.
This is the content-only path and has the same remote effect as `app publish`.

If a prior release created an undeployed version and stopped before deployment,
the local Worker state identifies that pending version. A later release resumes
it: publish its build, then deploy it, without creating another version.

### Resources resolved

When Cloudflare resource IDs are missing from `cloudflare-config.js`, release
prints the resolved IDs and stops. It does not bundle code, publish content, or
deploy. Add the reported IDs to configuration and run release again.

## First release and bootstrap

A new Durable Object namespace exists only after Cloudflare deploys the version
that declares it. On a Worker that has never served traffic, version creation
therefore deploys automatically to provision the namespace.

That reverses the normal order for the first release: the new build briefly
serves before it has a content closure. Requests can fail during this window.
Release reports the window and immediately publishes with bootstrap enabled:

1. Commit an empty closure so Publishing API resource requests can open a
   snapshot.
2. Upload every local resource.
3. Replace the empty closure with the complete content tree.

Release does not issue a second deployment after this bootstrap because the
version is already serving traffic. If an interrupted first release is run
again, the recorded live build without a publish record is bootstrap-published.

## Failure recovery

Each phase has a different safe recovery:

| Failure point | Remote state | Recovery |
| --- | --- | --- |
| Resource resolution | No version, publish, or deployment occurred. | Add the reported IDs to `cloudflare-config.js`, then rerun release. |
| Version creation | No new version was accepted or recorded. | Fix the Cloudflare error, then rerun release. |
| Publish after ordinary version creation | The new version exists but is undeployed; traffic did not move. Uploaded blobs, if any, are inert without a closure. | Fix the publishing error and rerun release. The pending version is resumed. |
| Bootstrap publish on the first release | The new version is already deployed and requests may fail because its build lacks a complete closure. | Rerun release immediately. If needed, run `app publish --environment <environment> --build-id <BUILD_ID> --bootstrap`. |
| Deployment | The new build has a committed closure, but its version remains undeployed. | Run `cloudflare deploy-version --environment <environment> <VERSION_ID>`. |
| Content-only publish | No version was created and no deployment occurred. The previous closure remains live. | Fix the publishing error and rerun release or `app publish`. |

The command records Cloudflare version state in
`.kixx/cloudflare-state.<environment>.json` and publishing/deployment state in
`.kixx/app-state.<environment>.json`. Keep both files when moving release work
between machines; they allow interrupted releases and content-only changes to
resolve the intended build.
