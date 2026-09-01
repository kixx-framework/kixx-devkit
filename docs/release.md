# Cloudflare release

`kixx.js cloudflare release --environment <name>` ships Worker code and
content through one pre-staged release workflow.

Options are `--environment/-e`, `--force`, `--verbose`, `--origin`, and
`--token`. Configuration and credentials are the union of those documented in
[`create-worker-version.md`](create-worker-version.md) and
[`publish.md`](publish.md).

## Phase order

For changed Worker inputs the command:

1. prepares and freezes the exact Worker payload and its unique `BUILD_ID`;
2. uploads content objects and creates an immutable Publishing API Release;
3. assigns that Release to the future build with `If-None-Match: *`;
4. reads the pointer back and verifies its Release id;
5. uploads the prepared Worker payload; and
6. deploys it, unless Cloudflare had to deploy during creation to provision a
   Durable Object namespace.

Content is therefore ready before any upload that could move traffic. A build
id collision stops at the first-assignment precondition and never overwrites
the existing pointer.

## Other outcomes

When Worker inputs are unchanged, the command creates a content Release and
compare-and-swap assigns it to the `runningBuildId` returned by Publishing API
discovery. It creates no Worker version or future pointer and deploys nothing.

When resource IDs are resolved, the command prints them and stops after Worker
preparation. It performs no content scan, Release creation, assignment,
Worker-version upload, or deployment.

## Failure recovery

| Failure point | Remote state and recovery |
| --- | --- |
| Before future-build assignment | Objects or an immutable Release may remain; traffic and Worker versions are unchanged. Fix the error and rerun. |
| After assignment, before Worker creation | An inert future pointer may remain. Inspect the reported build id before retrying; traffic is unchanged. |
| Worker creation | The verified future pointer remains inert unless Cloudflare forced deployment. Inspect the reported build and retry safely. |
| Explicit deployment | The build is staged and the version is undeployed. Run `cloudflare deploy-version <version-id> --environment <name>`. |
| Content-only publish | No Worker version or deployment occurred. Fix the publishing error and rerun. |

Cloudflare artifact identity remains recorded in
`.kixx/cloudflare-state.<environment>.json`. Publishing API discovery and build
pointers are authoritative for content; there is no application-state file or
empty-content setup procedure.
