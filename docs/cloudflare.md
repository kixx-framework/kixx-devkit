# `kixx.js cloudflare` — Worker Deployment

Commands for creating a Cloudflare Worker, packaging and uploading versions,
deploying traffic, and shipping code and content together. See
[configuration.md](configuration.md) for `--environment` and the shared
Cloudflare and Publishing API settings.

## `create-worker`

Creates the Worker named by one Cloudflare environment configuration. It does
not package, upload, or deploy a Worker version.

```sh
kixx.js cloudflare create-worker --environment production
```

`--environment` (`-e`) is required and selects
`environments.<environment>.WORKER` in `cloudflare-config.js`.

After creation, use `create-worker-version` to upload an undeployed version,
or use `release` to stage application content and deploy a version as one
release workflow.

## `create-worker-version`

Packages a Kixx application as a Cloudflare Worker version and uploads it
undeployed when its inputs changed.

It does not create the Worker itself. Use `create-worker` before this command
when the configured Worker does not exist.

```sh
kixx.js cloudflare create-worker-version --environment production
```

Options:

| Option | Meaning |
| --- | --- |
| `--environment`, `-e` | Required environment beneath `environments` in `cloudflare-config.js`. |
| `--force` | Upload another version even when the recorded inputs are unchanged. |

The configured API token must be able to inspect the Worker and its configured
resources, create Worker versions, and create any D1 database or KV namespace
whose ID is not yet configured.

### Project inputs

The project directory supplies:

```text
cloudflare-config.js
cloudflare-server.js
.env.<environment>
.env.<environment>.secrets
.kixx/cloudflare-state.<environment>.json   # created after an upload
```

Both dotenv files are required. An empty file is valid, but an absent file is
treated as a likely environment-name mistake and stops the command.

#### `cloudflare-config.js`

The command reads one environment block:

```js
export default {
    environments: {
        production: {
            WORKER: {
                name: 'example-worker',
            },
            WORKER_VERSION: {
                compatibility_date: '2026-08-01',
                compatibility_flags: [],
            },
        },
    },
};
```

`WORKER.name` identifies the existing Cloudflare Worker. `WORKER_VERSION`
provides version-level runtime configuration. Worker-level settings such as
observability, logpush, and the workers.dev subdomain belong to `create-worker`
and are not updated here.

`WORKER_VERSION` accepts exactly five keys: `compatibility_date`,
`compatibility_flags`, `limits`, `placement`, and `cache_options`. Any other
key, including a typo such as `compatibilty_date`, is rejected with a usage
error naming the offending configuration path. `annotations` is rejected too:
the command generates `workers/tag` and `workers/triggered_by` itself and
overwrites whatever `WORKER_VERSION` carries there, so an authored
annotations block is command-owned, not a supported input.

Optional application resource blocks produce bindings:

| Configuration | Cloudflare binding |
| --- | --- |
| `DOCUMENT_STORE` | D1 database |
| `KEY_VALUE_STORE` | KV namespace |
| `CONTENT_STORE` | KV namespace and Durable Object namespace |
| `OBJECT_STORE.buckets` | One R2 binding per bucket |

The command verifies configured D1 and KV IDs. It does not verify or create R2
buckets.

#### Environment files

Every value in `.env.<environment>` becomes a `plain_text` binding. Every value
in `.env.<environment>.secrets` becomes a `secret_text` binding.

Names must use shell-style identifier syntax: a letter or underscore followed
by letters, digits, or underscores. Duplicate names in one file or across
binding sources are rejected.

Two names are command-owned:

- `ENVIRONMENT` always comes from `--environment`. An `ENVIRONMENT` value in
  the plain file is ignored so a copied dotenv file cannot select the wrong
  configuration inside the Worker.
- `BUILD_ID` is generated for each uploaded version. Declaring it in either
  dotenv file is an error.

The dotenv parser is intentionally small. It supports `NAME=value`, blank
lines, whole-line comments, and matching single or double quotes around a
value. It does not expand variables, interpret inline comments, or support
multiline values.

### Processing pipeline

The command performs these phases in order.

#### 1. Load and validate command configuration

The CLI locates the project, loads `cloudflare-config.js`, loads merged Kixx
secrets, and requires `--environment`. Environment-specific Cloudflare paths
are validated inside the version pipeline because the CLI runner cannot know
the selected environment before parsing the option.

#### 2. Inspect the Worker

The command fetches `WORKER.name` from Cloudflare. A missing Worker produces a
usage error naming the `create-worker` command to run.

The Worker record also tells the command:

- whether the Worker has ever been deployed; and
- which Durable Object class namespaces appear to be provisioned.

Those facts determine whether standalone creation is safe.

#### 3. Resolve D1 and KV resources

For each configured D1 database or KV namespace:

- A non-null ID is fetched to verify that it exists.
- A missing ID is resolved by resource name. An existing resource is adopted;
  otherwise the resource is created.

When any ID is resolved, the command prints every resolved configuration path
and ID, then stops without bundling or creating a version. The developer must
put those IDs in `cloudflare-config.js` and run the command again. The command
does not rewrite executable configuration files.

Resolving by name makes this provisioning phase repeatable if a run is
interrupted or the reported IDs have not yet been recorded.

#### 4. Build bindings and Durable Object exports

The command combines resource configuration, the selected environment, and the
two dotenv files into a deterministically name-sorted binding array.

It also creates a declarative Cloudflare `exports` map for Durable Objects.
Classes currently configured by `CONTENT_STORE` are live SQLite-backed exports.
Explicit declarations in `DURABLE_OBJECT_MIGRATIONS` represent lifecycle
operations:

```js
DURABLE_OBJECT_MIGRATIONS: [
    { action: 'rename', from: 'OldName', to: 'NewName' },
    { action: 'delete', className: 'DeadName' },
    { action: 'transfer', from: 'Name', fromScript: 'old-worker', to: 'Name' },
    { action: 'transfer-away', className: 'Name', toScript: 'new-worker' },
],
```

Despite the configuration key's name, these declarations become the modern
declarative `exports` payload, not Cloudflare's legacy `migrations` payload.
Cloudflare reconciles the declared desired state when the version is deployed.

#### 5. Package the module graph

`cloudflare-server.js` is always the entry module. Starting there, the bundler
parses static imports and recursively includes reachable `.js` and `.mjs`
modules.

This is a module packager, not a transpiler or single-file linker:

- Each source file remains a separate ES module.
- Import specifiers are left unchanged.
- Comments are removed while line positions are preserved.
- No tree shaking, syntax transformation, minification, or source-map
  generation occurs.
- `node:` and `cloudflare:` specifiers remain external for the runtime.

The build rejects:

- undeclared bare imports, including packages from `node_modules`;
- modules outside the directory containing `cloudflare-server.js`;
- extensions other than `.js` and `.mjs`;
- CommonJS modules;
- missing files or path-casing mistakes; and
- dynamic `import()` calls whose specifier is not a string literal.

Cloudflare receives the modules with project-relative POSIX names and base64
encoded contents. `cloudflare-server.js` is marked as `main_module`.

#### 6. Decide whether an upload is needed

The command calculates three SHA-256 hashes:

| Hash | Inputs |
| --- | --- |
| `modulesHash` | Module names and comment-stripped contents, independent of module order. |
| `bindingsHash` | Bindings and the Durable Object exports map. |
| `configHash` | The `WORKER_VERSION` object. |

It compares them with `.kixx/cloudflare-state.<environment>.json`. A missing
state file or a changed hash requires an upload. `--force` also requires one,
and so do these:

- A bound Durable Object class whose namespace is still missing. This
  overrides an unchanged hash result so it cannot remain unprovisioned
  indefinitely.
- `environments.<environment>.WORKER.name` naming a different Worker than the
  one recorded in the state file. The state file is scoped by environment, not
  by Worker, so a retarget would otherwise leave the new Worker never
  receiving a version while the command reports success. The previous name is
  reported as `retargetedFrom` and printed as its own line in the command
  output.

`BUILD_ID` is absent from every hash. It is generated after the upload
decision, so the clock alone does not make an unchanged build appear
different.

The idempotency decision is local. The command does not compare the candidate
payload with versions currently stored by Cloudflare. Keep the state file with
the project when the same environment is built from multiple machines.

#### 7. Create the version

For a required upload, the command:

1. Generates a UTC timestamp plus collision-resistant component as `BUILD_ID`.
2. Adds `BUILD_ID` as a plain-text binding.
3. Adds `workers/tag` with the build ID.
4. Adds `workers/triggered_by` naming this command.
5. Adds every packaged module, binding, and Durable Object export to the
   version payload.
6. Calls Cloudflare's Worker Versions API.

The new version exists in Cloudflare but receives no traffic.

#### 8. Record state and report the result

Only after Cloudflare successfully creates the version does the command
replace the environment's state file. The record contains:

```json
{
    "workerName": "example-worker",
    "buildId": "2026-08-31T12-34-56Z-<unique-id>",
    "versionId": "cloudflare-version-id",
    "createdAt": "2026-08-31T12:34:56.000Z",
    "deployed": false,
    "modulesHash": "...",
    "bindingsHash": "...",
    "configHash": "..."
}
```

A failed API request writes no new state. If the upload succeeds but the local
write fails, a later run may create a duplicate version because it has no
record of the successful upload.

Command output identifies the environment and Worker, reports which hash
groups changed, prints the build and version IDs, states that it remains
undeployed, shows Durable Object reconciliation when Cloudflare returns it,
and names the state file written. When the upload was triggered by a Worker
retarget, an unmissable `RETARGETED from Worker "..."` line precedes the hash
lines so an upload with three `unchanged` hashes does not read as a defect.

### Durable Object deployment policy

Cloudflare provisions a new Durable Object namespace only when the version
declaring it is deployed. If a prepared version would require that forced
deployment, this standalone command stops before upload and directs the
operator to `release`. That command stages and verifies content before making
the same prepared upload.

Tombstone reconciliation may report stale entries which are safe to remove
from `DURABLE_OBJECT_MIGRATIONS`. A tombstone can remain in configuration
without being applied twice, but Cloudflare may continue reporting it until it
is removed.

### Sample application

`tmp/sample-app/` demonstrates the expected project layout.

- `cloudflare-server.js` imports `env` from `cloudflare:workers`, selects the
  configured environment, constructs the application, exports its Durable
  Object class, and provides the default `fetch` handler.
- `cloudflare-config.js` defines the production Worker, version settings, D1
  and KV resources, and `ContentAddressableIndexStore` bindings.
- `plugins/cloudflare.js` exports `ContentAddressableIndexStore`, matching
  `CONTENT_STORE.durableObjectClassName`.
- `example.env` and `example.env.secrets` document plain and secret values.
  Copy them to `.env.production` and `.env.production.secrets`, then replace
  their example values before a production build.

At the time this document was written, packaging the sample entry succeeded
and found 201 reachable modules. That count is descriptive rather than an
invariant; it changes as the sample application changes.

## `deploy-version`

Routes all traffic to an existing Cloudflare Worker version. It supports
promoting an uploaded version and rolling back to an older version without
creating new code.

```sh
node kixx.js cloudflare deploy-version -e <environment> [version-id]
```

When `version-id` is omitted, the command uses `versionId` from
`.kixx/cloudflare-state.<environment>.json`.

Options:

- `--environment`, `-e` — required Cloudflare environment.
- `--force` — deploy without checking the version's `BUILD_ID` through the
  Publishing API.

Unless `--force` is used, the Publishing API origin and token from
[configuration.md](configuration.md) guard the deployment.

### Content safety guard

The command reads the selected version from Cloudflare and finds its
plain-text `BUILD_ID` binding. It then checks the Publishing API build pointer
for that id.

Without an assigned Release, the command refuses deployment. Create and stage
content with `app publish --build-id <build-id>` or assign an existing Release
with `app assign-build` before retrying.

Use `--force` only when the Publishing API is unavailable or the build pointer
has been independently verified. The command records that the guard was
bypassed in its output.

### State and output

Cloudflare receives a percentage deployment assigning the selected version
100% of traffic. After Cloudflare accepts it, the command updates the
version's deployment status in `.kixx/cloudflare-state.<environment>.json`.
Publishing API discovery and build pointers remain authoritative for content
and running-build decisions.

If version lookup or deployment fails, Cloudflare state is not changed.

## `release`

Ships Worker code and content through one pre-staged release workflow.

```sh
kixx.js cloudflare release --environment <name>
```

Options are `--environment`/`-e`, `--force`, `--verbose`, `--origin`, and
`--token`. Configuration and credentials are the union of `create-worker-version`
above and `app publish` in [app.md](app.md).

### Phase order

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

### Other outcomes

When Worker inputs are unchanged, the command creates a content Release and
compare-and-swap assigns it to the `runningBuildId` returned by Publishing API
discovery. It creates no Worker version or future pointer and deploys nothing.

When resource IDs are resolved, the command prints them and stops after Worker
preparation. It performs no content scan, Release creation, assignment,
Worker-version upload, or deployment.

### Failure recovery

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
