# Implementation Plan: Cloudflare Bootstrap Command

## Implementation Approach

The first Cloudflare deployment has a circular dependency. The Content Store's
Durable Object namespace exists only after a version declaring it is deployed.
Ordinary `create-worker-version` refuses that deployment and points to
`cloudflare release`, which must first stage content through the Publishing
API. On a new environment, that API is not online and no Publishing API token
exists.

Add one command for exactly that initial state:

```sh
kixx.js cloudflare bootstrap --environment <name> [dotenv-file]
```

The dotenv path defaults to `.env.<environment>.secrets`, matching
`set-secrets`. Bootstrap builds the normal application artifact, carries every
declared secret as a `secret_text` binding, and creates the first Worker
version with `deploy: true`. That one mutation provisions Durable Object
namespaces and puts the Admin and Publishing APIs online. The operator then
runs `admin accept-invite`, `admin create-publishing-token`, and
`cloudflare release`. Nothing after bootstrap changes.

### Reuse, not a parallel pipeline

Bootstrap is an `initialSecrets` option on the existing
`prepareWorkerVersion()`, uploaded by the existing
`createPreparedWorkerVersion()`. No new orchestration module.

- `bindingsForHash` keeps the normal `inherit` secret bindings. Only the
  uploaded `CloudflareWorkerVersion` receives `secret_text` bindings in their
  place. `createPreparedWorkerVersion()` already rewrites inherited
  `version_id` values to the created version ID before hashing, so the
  recorded `bindingsHash` matches the next normal build without new code.
- `CloudflareWorkerVersion` already supports `secret_text`.
- After bootstrap, `release` with unchanged source takes its existing
  `skipped` → content-only path: it resolves the running build (the bootstrap
  `BUILD_ID`) and assigns the first content Release to it. With changed source
  it inherits secrets from the bootstrap version, which
  `readSecretBindingNames()` recognizes as `secret_text`.

### Pristine precondition

Bootstrap runs only when there is no local state file and Cloudflare lists no
versions for the Worker. An empty version list implies no deployment and no
provisioned Durable Object namespaces, so no further remote facts are checked.
There is no `--force` and no pre-create recheck.

### Post-deploy state-write failure

If Cloudflare accepts the deploying upload but the local state write fails,
the error reports the version ID, `BUILD_ID`, that traffic changed, and the
complete state JSON (IDs and hashes only, never secret values). The operator
saves that JSON to the reported path, or deletes the still-empty Worker and
reruns `create-worker` and `bootstrap`. No recovery command.

This wrap lives in `createPreparedWorkerVersion()`, so `create-worker-version`
and `release` gain the same diagnostic.

### Cross-cutting boundaries

- Bootstrap deploys unconditionally. It sets the deploy flag directly and does
  not go through `resolveDeployment()`, which deploys only for unprovisioned
  Durable Object classes.
- `create-worker-version` and `release` never read `.env.<environment>.secrets`.
- Out of scope: Worker creation, R2 creation, `send_email` bindings, admin
  creation, content publishing, routes, and custom domains.
- No new dependencies. Tests use the existing injection points
  (`apiClient`, `fileSystem`, `bundleModules`, `now`, `generateUniqueId`,
  `output`).

---

### Task CB-1: Build and deploy the first Worker version with initial secrets

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`

**Objective**

`prepareWorkerVersion({ ..., initialSecrets })` prepares a deploying first
version carrying direct secret values, only for a pristine Worker, and
`createPreparedWorkerVersion()` records state that the next normal build
treats as its source.

**Scope**

- In: `initialSecrets` option, secret input validation, pristine check,
  unconditional deploy, bootstrap annotation, state-write failure diagnostic.
- Out: CLI parsing, dotenv reading, output rendering, docs (CB-2).

**Design and invariants**

- Without `initialSecrets`, behavior is unchanged.
- With `initialSecrets`:
  - Require no local state and an empty `listWorkerVersions(workerName,
    { page: 1, per_page: 1 })` result. Fail with a `UsageError` that says
    bootstrap only applies to a Worker with no versions.
  - Require the supplied names to equal the declared names exactly. Reject
    missing, undeclared, reserved (`BUILD_ID`, `ENVIRONMENT`), non-string, and
    empty values before bundling. Share the reserved-name set with
    `manage-worker-secrets.js` rather than duplicating it.
  - Messages may name keys, never values.
  - Skip `validateSourceState()`'s "no source version" error.
  - Keep the `resources-resolved` early return unchanged.
  - Build bindings with the existing `buildWorkerBindings()`. Pass a
    placeholder `secretVersionId`; `createPreparedWorkerVersion()` replaces it
    with the real ID before hashing.
  - Add `secret_text` bindings to the uploaded version in place of each
    `inherit` binding. `bindingsForHash` stays `inherit`.
  - Set `deployOnCreate: true`, bypassing `resolveDeployment()`.
  - Annotate `workers/triggered_by` as `kixx.js cloudflare bootstrap`.
- `createPreparedWorkerVersion()`: when the state write throws after a
  successful upload, throw an `Error` with `cause` that names the version ID,
  `BUILD_ID`, deployment status, state path, and the state JSON.
- Secret values must not appear in the returned result. Drop them from the
  prepared object once the artifact is built; the frozen artifact is the only
  holder.

**Expected touch points**

- `lib/cloudflare/create-worker-version.js` — `initialSecrets` branch and
  write-failure diagnostic.
- `lib/cloudflare/manage-worker-secrets.js` — export the reserved-name set.
- `test/unit-tests/lib/cloudflare/create-worker-version.test.js` — new cases.

Treat this list as orientation, not permission to ignore other necessary
files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A pristine Worker receives one `createWorkerVersion` call with
  `deploy: true`, `secret_text` bindings for every declared secret, and no
  `inherit` bindings.
- [ ] The recorded `bindingsHash` equals the hash a following normal
  `prepareWorkerVersion()` computes against the written state, so that run
  returns `skipped`.
- [ ] Existing local state or any remote version fails before bundling or
  upload.
- [ ] Missing, undeclared, reserved, empty, and non-string secrets fail before
  bundling and name keys only.
- [ ] Missing D1/KV IDs return `resources-resolved` without an upload.
- [ ] A state-write failure after upload reports version ID, `BUILD_ID`,
  deployment status, and state JSON.
- [ ] One test passes sentinel secret values and asserts none appear in the
  result, written state, or thrown error messages.
- [ ] Existing create-worker-version and release tests pass unchanged.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare test/unit-tests/lib/release` — bootstrap and regression coverage.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task CB-2: Expose `cloudflare bootstrap` and document the first deployment

**Status:** Not started
**Depends on:** CB-1
**Documentation:** `commands/README.md`, `agents/docs/code-style-guide.md`, `test/README.md`, `docs/cloudflare.md`, `docs/configuration.md`

**Objective**

Operators can run the bootstrap from the CLI and follow a documented sequence
from `create-worker` to the first `cloudflare release`.

**Scope**

- In: command module, metadata, dotenv path resolution, output, README list,
  docs, command tests.
- Out: workflow logic (CB-1).

**Design and invariants**

- Model on `commands/cloudflare/set-secrets.js`: same options, positional,
  default path, `requiredSecrets`, and injected `readEnvValues`,
  `createApiClient`, `fileSystem`, `output`. Inject `prepareWorkerVersion` and
  `createPreparedWorkerVersion` for tests.
- Call `prepare` then `createPrepared`, as `cloudflare-release.js` does.
- `resources-resolved` output reuses the create-worker-version format, says no
  version was created, and tells the operator to record IDs and rerun.
- Success output: environment, Worker, version ID, `BUILD_ID`, state path,
  Durable Object reconciliation, and the next three commands.
- Output may list secret names, never values.
- Docs: why bootstrap exists (the circular dependency), that the deployed
  Worker serves APIs but no content until the first release, that it is
  unavailable once any version exists, and the two options after a failed
  state write.

**Expected touch points**

- `commands/cloudflare/bootstrap.js` — CLI adapter.
- `commands/cloudflare/index.js` — metadata.
- `test/unit-tests/commands/cloudflare/bootstrap.test.js` — path resolution,
  wiring, output for each outcome.
- `README.md` — command list.
- `docs/cloudflare.md` — first-deployment runbook.
- `docs/configuration.md` — the secrets file is read only by `set-secrets` and
  `bootstrap`.

Treat this list as orientation, not permission to ignore other necessary
files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `kixx.js cloudflare --help` lists `bootstrap`.
- [ ] Default and explicit dotenv paths resolve like `set-secrets`.
- [ ] Output covers `resources-resolved` and `created`, and prints no secret
  values.
- [ ] Docs give an executable sequence: `create-worker`, `bootstrap`,
  `admin accept-invite`, `admin create-publishing-token`, `cloudflare release`.

**Validation**

- `node run-tests.js test/unit-tests/commands/cloudflare/bootstrap.test.js` — CLI behavior.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
