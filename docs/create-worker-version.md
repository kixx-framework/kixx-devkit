# Cloudflare create-worker-version

`kixx.js cloudflare create-worker-version` packages a Kixx application as a
Cloudflare Worker version, uploads it when its inputs changed, and optionally
routes all traffic to the new version.

It does not create the Worker itself. Use `cloudflare create-worker` before this
command when the configured Worker does not exist.

## Usage

```sh
kixx.js cloudflare create-worker-version --environment production
```

Options:

| Option | Meaning |
| --- | --- |
| `--environment`, `-e` | Required environment beneath `environments` in `cloudflare-config.js`. |
| `--force` | Upload another version even when the recorded inputs are unchanged. |
| `--deploy` | Send 100% of traffic to the version created by this run. |

The command requires these values in the merged `.kixx/secrets.json`
configuration:

```text
cloudflare.accountId
cloudflare.apiToken
```

The API token must be able to inspect the Worker and its configured resources,
create Worker versions, and create any D1 database or KV namespace whose ID is
not yet configured.

## Project inputs

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

### cloudflare-config.js

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
observability, logpush, and the workers.dev subdomain belong to
`cloudflare create-worker` and are not updated here.

Optional application resource blocks produce bindings:

| Configuration | Cloudflare binding |
| --- | --- |
| `DOCUMENT_STORE` | D1 database |
| `KEY_VALUE_STORE` | KV namespace |
| `CONTENT_STORE` | KV namespace and Durable Object namespace |
| `OBJECT_STORE.buckets` | One R2 binding per bucket |

The command verifies configured D1 and KV IDs. It does not verify or create R2
buckets.

### Environment files

Every value in `.env.<environment>` becomes a `plain_text` binding. Every value
in `.env.<environment>.secrets` becomes a `secret_text` binding.

Names must use shell-style identifier syntax: a letter or underscore followed
by letters, digits, or underscores. Duplicate names in one file or across
binding sources are rejected.

Two names are command-owned:

- `ENVIRONMENT` always comes from `--environment`. An `ENVIRONMENT` value in the
  plain file is ignored so a copied dotenv file cannot select the wrong
  configuration inside the Worker.
- `BUILD_ID` is generated for each uploaded version. Declaring it in either
  dotenv file is an error.

The dotenv parser is intentionally small. It supports `NAME=value`, blank lines,
whole-line comments, and matching single or double quotes around a value. It
does not expand variables, interpret inline comments, or support multiline
values.

## Processing pipeline

The command performs these phases in order.

### 1. Load and validate command configuration

The CLI locates the project, loads `cloudflare-config.js`, loads merged Kixx
secrets, and requires `--environment`. Environment-specific Cloudflare paths are
validated inside the version pipeline because the CLI runner cannot know the
selected environment before parsing the option.

### 2. Inspect the Worker

The command fetches `WORKER.name` from Cloudflare. A missing Worker produces a
usage error naming the `cloudflare create-worker` command to run.

The Worker record also tells the command:

- whether the Worker has ever been deployed; and
- which Durable Object class namespaces appear to be provisioned.

Those facts control the Durable Object deployment policy described below.

### 3. Resolve D1 and KV resources

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

### 4. Build bindings and Durable Object exports

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

### 5. Package the module graph

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

### 6. Decide whether an upload is needed

The command calculates three SHA-256 hashes:

| Hash | Inputs |
| --- | --- |
| `modulesHash` | Module names and comment-stripped contents, independent of module order. |
| `bindingsHash` | Bindings and the Durable Object exports map. |
| `configHash` | The `WORKER_VERSION` object. |

It compares them with
`.kixx/cloudflare-state.<environment>.json`. A missing state file or a changed
hash requires an upload. `--force` also requires one. A bound Durable Object
class whose namespace is still missing overrides an unchanged hash result so it
cannot remain unprovisioned indefinitely.

`BUILD_ID` is absent from every hash. It is generated after the upload decision,
so the clock alone does not make an unchanged build appear different.

The idempotency decision is local. The command does not compare the candidate
payload with versions currently stored by Cloudflare. Keep the state file with
the project when the same environment is built from multiple machines.

Known idempotency and option issues are tracked in
`../agents/plans/create-worker-version-issues.md`.

### 7. Create the version

For a required upload, the command:

1. Generates a UTC timestamp-based `BUILD_ID`.
2. Adds `BUILD_ID` as a plain-text binding.
3. Adds `workers/tag` with the build ID.
4. Adds `workers/triggered_by` naming this command.
5. Adds every packaged module, binding, and Durable Object export to the
   version payload.
6. Calls Cloudflare's Worker Versions API.

Without deployment, the new version exists in Cloudflare but receives no
traffic. With deployment, the create-version request asks Cloudflare to send
100% of traffic to it.

### 8. Record state and report the result

Only after Cloudflare successfully creates the version does the command replace
the environment's state file. The record contains:

```json
{
    "workerName": "example-worker",
    "buildId": "2026-08-31T12-34-56Z",
    "versionId": "cloudflare-version-id",
    "createdAt": "2026-08-31T12:34:56.000Z",
    "deployed": false,
    "modulesHash": "...",
    "bindingsHash": "...",
    "configHash": "..."
}
```

A failed API request writes no new state. If the upload succeeds but the local
write fails, a later run may create a duplicate version because it has no record
of the successful upload.

Command output identifies the environment and Worker, reports which hash groups
changed, prints the build and version IDs, states whether deployment occurred,
shows Durable Object reconciliation when Cloudflare returns it, and names the
state file written.

## Durable Object deployment policy

Cloudflare provisions a new Durable Object namespace only when the version
declaring it is deployed. The command detects a bound live class which is not in
the Worker's provisioned namespace list before uploading.

- If `--deploy` is present, the new version is deployed.
- If the Worker has never served traffic, the command deploys automatically.
  This provisions the namespace while displacing no existing deployment, and
  the output calls out the automatic action.
- If the Worker already serves traffic, the command stops and requires
  `--deploy` as explicit confirmation that the new version may take 100% of
  traffic.
- If all bound classes are already provisioned, no automatic deployment is
  necessary.

Tombstone reconciliation may report stale entries which are safe to remove from
`DURABLE_OBJECT_MIGRATIONS`. A tombstone can remain in configuration without
being applied twice, but Cloudflare may continue reporting it until it is
removed.

## Sample application

`tmp/sample-app/` demonstrates the expected project layout.

- `cloudflare-server.js` imports `env` from `cloudflare:workers`, selects the
  configured environment, constructs the application, exports its Durable
  Object class, and provides the default `fetch` handler.
- `cloudflare-config.js` defines the production Worker, version settings, D1 and
  KV resources, and `ContentAddressableIndexStore` bindings.
- `plugins/cloudflare.js` exports `ContentAddressableIndexStore`, matching
  `CONTENT_STORE.durableObjectClassName`.
- `example.env` and `example.env.secrets` document plain and secret values. Copy
  them to `.env.production` and `.env.production.secrets`, then replace their
  example values before a production build.

At the time this document was written, packaging the sample entry succeeded and
found 201 reachable modules. That count is descriptive rather than an invariant;
it changes as the sample application changes.

