# Implementation Plan: Cloudflare Bootstrap Command

## Implementation Approach

Add a dedicated first-deployment workflow:

```sh
kixx.js cloudflare bootstrap --environment <name> [dotenv-file]
```

The optional dotenv path defaults to `.env.<environment>.secrets`. The command
is the only Worker build operation allowed to read that file. It packages the
normal application, supplies every actively declared Worker secret as an
initial `secret_text` binding, and creates the first Worker version with
deployment enabled. That single remote mutation provisions any new Durable
Object namespaces and puts the application APIs online without requiring a
pre-existing Publishing API or content assignment.

Bootstrap is a distinct state transition, not a flag on
`create-worker-version` or `release`. It has no `--force` option and succeeds
only when Cloudflare and local state both prove that the configured Worker has
never had a version or deployment. An interrupted attempt that created a
remote version must be recovered explicitly; rerunning bootstrap must never
guess whether the prior mutation committed.

The normal deployment invariants remain unchanged:

- `create-worker-version` and `release` never read local secret values.
- Later versions inherit declared secrets from the exact `versionId` in
  `.kixx/cloudflare-state.<environment>.json`.
- Only `release` may deploy a normal code change that needs Durable Object
  reconciliation.
- `deploy-version` continues to require a published content assignment unless
  its existing generic `--force` escape hatch is explicitly used.

### Bootstrap state transition

```text
existing Worker
    + no local state
    + no remote versions
    + no prior deployment
        |
        | resolve D1/KV resources; stop if IDs must be recorded
        v
prepare normal modules, resources, exports, config, BUILD_ID, and initial secrets
        |
        | create Worker version with deploy=true
        v
first full application version serving traffic; Durable Object namespaces exist
        |
        | write cloudflare-state.<environment>.json with deployed=true
        v
existing admin and release commands bootstrap the root admin and initial content
```

The first deployed version may serve API routes before application content is
assigned. Command output and documentation must tell the operator to create the
root admin, mint a Publishing API token, and run `cloudflare release`
immediately. Hostname exposure is an operator-owned Worker-level decision; the
command does not create routes or change `WORKER.subdomain` after Worker
creation.

### Secret and hash model

The bootstrap input must contain exactly the active names declared in
`example.env.secrets`: no missing names, undeclared names, reserved names, or
empty values. Values exist only in memory long enough to construct the
Cloudflare request. They must never enter output, annotations, errors, state,
hashes, or test diagnostics.

The uploaded first version contains `secret_text` bindings. After Cloudflare
returns its version ID, the recorded `bindingsHash` must be calculated from the
same non-secret bindings and exports but with each declared secret normalized
to an `inherit` binding whose `version_id` is the new version ID. A subsequent
normal build therefore constructs the same hash and skips when code,
configuration, and bindings are otherwise unchanged.

### Recovery boundary

If Cloudflare creates and deploys the version but the local state write fails,
the error must preserve the Worker name, version ID, BUILD_ID, and the fact that
traffic changed. Add a companion recovery command:

```sh
kixx.js cloudflare recover-bootstrap-version -e <environment> <version-id>
```

Recovery accepts only an explicit version ID. It rebuilds the expected local
artifact, compares remote modules, runtime settings, non-secret bindings,
exports, BUILD_ID, annotations, and secret names, verifies that the selected
version is Cloudflare's latest version and is the sole version receiving 100%
of traffic, then writes the missing state. Secret values cannot be read back;
recovery verifies names only and must say so. If the current Cloudflare API
cannot prove the active deployment identity, stop that task as blocked rather
than inferring it from `deployed_on` or `latest`.

### Cross-cutting boundaries

- This plan does not add `send_email` bindings. That is a separate Worker
  binding feature and must be completed before an application requiring email
  is considered deployment-ready.
- This plan does not create or verify R2 buckets; current version creation
  continues to let Cloudflare validate configured R2 bindings.
- This plan does not create the Worker. Operators run `cloudflare create-worker`
  first so Worker-level creation and first-version deployment remain separate
  recovery boundaries.
- This plan does not publish initial content or create an administrator. It
  makes the existing Admin and Publishing APIs reachable so their existing
  commands can perform those operations.
- Do not add a dependency. Use the existing dotenv parser, bundler, hashing,
  API client, filesystem adapter, and Worker-version model.
- Accept collaborators through dependency injection where unit tests need to
  replace filesystem access, Cloudflare API calls, clocks, ID generation,
  bundling, or output. Tests must not replace process globals.
- Validation is limited to linting and unit tests with injected mocks. Focus
  coverage on security boundaries, state transitions, and failure behavior;
  100% unit test coverage is not a goal.

---

### Task CB-1: Represent initial secrets without weakening normal builds

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`

**Objective**

Provide reusable preparation primitives that can build a first Worker artifact
with direct secret values while preserving the exact inherited-binding model
used by all later builds. This task owns secret input validation and canonical
binding hashing, but performs no remote mutation.

**Scope**

- In: exact declared-name/value validation, reserved-name and empty-value
  rejection, direct `secret_text` binding construction, post-creation
  normalization to exact-version `inherit` bindings, and value-free hashing.
- Out: Worker existence checks, resource creation, Cloudflare uploads, state
  writes, CLI rendering, recovery, email bindings, and content publishing.

**Design and invariants**

- Read declarations only from `example.env.secrets` and values only from the
  caller-supplied object. This layer does not choose or open a secrets file.
- Require the supplied and declared name sets to be identical. Sort names for
  deterministic validation, bindings, and messages.
- Reject `BUILD_ID` and `ENVIRONMENT`, empty values, non-string values,
  undeclared names, and missing declared names before bundling or network I/O.
- Error messages may name secret keys but must never interpolate values or
  serialize the input object.
- Preserve the existing normal-build contract: its bindings remain exact
  `inherit` bindings and it never opens `.env.<environment>.secrets`.
- Refactor shared artifact construction only as far as needed to prevent the
  bootstrap path from duplicating module packaging, resource bindings,
  Durable Object exports, annotations, and configuration validation.
- Calculate bootstrap state hashes after the remote version ID is known. Hash
  normalized inherited definitions and exports, never `secret_text` values.

**Expected touch points**

- `lib/cloudflare/worker-bindings.js` — express direct initial secrets and
  exact-version inherited secrets without duplicating collision checks.
- `lib/cloudflare/create-worker-version.js` — expose or extract reusable,
  value-free artifact and hash preparation where ownership remains coherent.
- `lib/cloudflare/bootstrap-worker.js` — bootstrap-specific secret validation
  and prepared artifact representation.
- `test/unit-tests/lib/cloudflare/worker-bindings.test.js` — direct/inherited
  binding contracts and collision behavior.
- `test/unit-tests/lib/cloudflare/create-worker-version.test.js` — regression
  proof that ordinary builds never read or carry local secret values.
- `test/unit-tests/lib/cloudflare/bootstrap-worker.test.js` — secret set and
  normalization behavior.

Treat this list as orientation, not permission to ignore other necessary
files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A bootstrap artifact can contain all declared names as `secret_text`
  bindings without exposing values outside the Cloudflare request payload.
- [ ] Missing, extra, reserved, empty, and non-string secret inputs fail before
  bundling or network calls and identify names without values.
- [ ] The persisted bootstrap bindings hash is identical to the hash produced
  by the next normal build inheriting those names from the created version.
- [ ] Existing normal builds still ignore `.env.<environment>.secrets`.
- [ ] No secret value appears in results, hashes, state-shaped objects,
  annotations, errors, or captured output.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/worker-bindings.test.js test/unit-tests/lib/cloudflare/bootstrap-worker.test.js test/unit-tests/lib/cloudflare/create-worker-version.test.js` — binding, secret-safety, hash, and normal-build regression coverage.
- `npm run lint` — all JavaScript style checks.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task CB-2: Create and deploy the first Worker version safely

**Status:** Not started
**Depends on:** CB-1
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`

**Objective**

Implement the bootstrap workflow that proves an environment is genuinely new,
resolves its managed resources, creates and deploys exactly one full Worker
version, and records durable local state. This task resolves the Durable Object
and Publishing API chicken-and-egg problem.

**Scope**

- In: environment and Worker configuration validation, local/remote pristine
  checks, D1/KV resolution, artifact preparation, one deploying version
  request, Durable Object reconciliation reporting data, state creation, and
  post-remote-write failure diagnostics.
- Out: command argument parsing and rendering, recovery after a lost state
  write, Worker creation, R2 creation, email bindings, admin creation, and
  initial content publishing.

**Design and invariants**

- Require no local environment state file.
- Fetch the configured Worker and require `deployed_on` to prove it has never
  been deployed, no provisioned Durable Object classes, and an empty remote
  version listing. A Worker with any version is not pristine even if none was
  deployed.
- Recheck the remote pristine conditions immediately before the create call so
  two operators cannot both pass an early check and bootstrap independently.
- Reuse `resolveResources()`. When it reports D1/KV IDs, return the existing
  `resources-resolved` style outcome and perform no bundling, upload,
  deployment, or state write.
- Generate one BUILD_ID and identify the command through non-secret Worker
  annotations.
- Call `createWorkerVersion()` once with `deploy: true`. This is intentional
  for bootstrap and does not flow through normal release policy.
- Use strict binding inheritance only where inherited bindings exist; the
  bootstrap artifact carries direct initial secrets.
- Record `deployed: true`, the remote version identity and timestamp, module
  and config hashes, and the normalized inherited bindings hash.
- If Cloudflare succeeds and state writing fails, throw an error that preserves
  Worker name, version ID, BUILD_ID, and deployment status and directs the
  operator to recovery. Never retry the remote mutation automatically.
- A second successful or interrupted bootstrap attempt must fail before any
  mutation and must not offer `--force` guidance.

**Expected touch points**

- `lib/cloudflare/bootstrap-worker.js` — bootstrap orchestration and result
  contract.
- `lib/cloudflare/worker-record.js` — only if the current remote-fact model
  needs an additional explicit pristine fact.
- `lib/cloudflare/cloudflare-api-client.js` — reuse the existing deploying
  version request; change only if the API contract needs a focused addition.
- `lib/cloudflare/worker-version-state.js` — state validation only if bootstrap
  exposes an unhandled state-shape requirement.
- `test/unit-tests/lib/cloudflare/bootstrap-worker.test.js` — phase ordering,
  races, resource resolution, one-call mutation, state, and failure recovery
  diagnostics.
- `test/unit-tests/lib/cloudflare/worker-record.test.js` — any added remote fact.

Treat this list as orientation, not permission to ignore other necessary
files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A pristine Worker with configured resource IDs receives one full version
  creation request with deployment enabled.
- [ ] A successful response writes complete state with `deployed: true` and a
  bindings hash compatible with the next inherited build.
- [ ] Missing D1/KV IDs are resolved and reported without creating a version.
- [ ] Existing local state, any remote version, any prior deployment, or a
  concurrently appearing version stops bootstrap before mutation.
- [ ] Cloudflare errors write no state.
- [ ] A state-write error after Cloudflare success reports the exact recovery
  identity without exposing secret values.
- [ ] Bootstrap remains separate from normal create/release deployment policy.
- [ ] Filesystem, API, clock, ID-generation, bundling, and state collaborators
  needed by unit tests can be injected without replacing globals.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/bootstrap-worker.test.js test/unit-tests/lib/cloudflare/worker-record.test.js test/unit-tests/lib/cloudflare/create-worker-version.test.js test/unit-tests/lib/release/cloudflare-release.test.js` — bootstrap behavior and normal deployment-policy regressions.
- `npm run lint` — all JavaScript style checks.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task CB-3: Recover a verified bootstrap version after local state loss

**Status:** Not started
**Depends on:** CB-2
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`, current official Cloudflare Workers Versions and Deployments API documentation

**Objective**

Provide a narrow recovery path for the one ambiguous bootstrap failure: the
remote version was created and deployed, but local state was not written. The
workflow reconstructs state only from an explicit, fully verified bootstrap
version and never performs a remote mutation.

**Scope**

- In: explicit-version recovery, deployment identity inspection, local artifact
  reconstruction, remote comparison, state reconstruction, command wiring,
  and operator warnings about unverifiable secret values.
- Out: arbitrary first-version adoption, secret repair, deployment changes,
  recovery when source files/configuration have changed, and recovery of normal
  code or secret-only versions.

**Design and invariants**

- Add `cloudflare recover-bootstrap-version -e <environment> <version-id>`;
  reject `latest`, missing IDs, and extra positionals.
- Require local state to be absent. Existing state must be resolved through the
  normal freshness rules, never overwritten by bootstrap recovery.
- Verify the configured Worker name, bootstrap annotations, BUILD_ID, creation
  timestamp, complete module contents, runtime configuration, non-secret
  bindings, Durable Object exports, and exact declared secret-name set.
- Rebuild the expected artifact from current source and configuration. Any
  difference blocks recovery and names fields/modules without printing secret
  values.
- Verify the selected version is Cloudflare's latest created version and the
  sole version receiving 100% of traffic using the deployments API. Add the
  smallest API-client read operation needed for this proof and encode its HTTP
  contract in tests.
- Do not treat `Worker.deployed_on` as proof of which version is active.
- State explicitly that secret values are unreadable and cannot be verified;
  recovery proves only their names and the non-secret artifact.
- Write state with `deployed: true` and the normalized inherited bindings hash.
- Perform a final remote freshness/deployment check immediately before writing
  state so recovery cannot bless a version displaced during verification.
- If Cloudflare's supported API cannot prove the active deployment identity,
  stop as blocked rather than selecting `latest` or adding an unsafe override.

**Expected touch points**

- `lib/cloudflare/recover-bootstrap-version.js` — verification and state
  reconstruction workflow.
- `lib/cloudflare/cloudflare-api-client.js` — deployments read operation, if
  required by the verified official API.
- `commands/cloudflare/recover-bootstrap-version.js` — positional validation,
  dependency wiring, and value-free result rendering.
- `commands/cloudflare/index.js` — recovery command metadata.
- `test/unit-tests/lib/cloudflare/recover-bootstrap-version.test.js` — local and
  remote verification matrix and final race check.
- `test/unit-tests/lib/cloudflare/cloudflare-api-client.test.js` — deployments
  read HTTP contract.
- `test/unit-tests/commands/cloudflare/recover-bootstrap-version.test.js` — CLI
  contract and output.

Treat this list as orientation, not permission to ignore other necessary
files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Recovery writes state only for an explicit, latest, currently
  100%-deployed bootstrap version matching current source and configuration.
- [ ] Any module, runtime, binding, export, BUILD_ID, annotation, secret-name,
  freshness, or deployment mismatch stops without writing.
- [ ] Recovery makes no Cloudflare mutation and never asks for or prints secret
  values.
- [ ] The reconstructed state lets the next normal build inherit secrets from
  the recovered version and skip unchanged inputs.
- [ ] Ambiguous Cloudflare protocol behavior blocks implementation rather than
  weakening verification.
- [ ] Remote reads, artifact reconstruction, filesystem access, and output are
  injectable for focused unit tests.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/recover-bootstrap-version.test.js test/unit-tests/lib/cloudflare/cloudflare-api-client.test.js test/unit-tests/commands/cloudflare/recover-bootstrap-version.test.js` — recovery and HTTP contracts.
- `npm run lint` — all JavaScript style checks.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task CB-4: Expose the bootstrap command and operator handoff

**Status:** Not started
**Depends on:** CB-2, CB-3
**Documentation:** `commands/README.md`, `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`, `docs/configuration.md`

**Objective**

Expose the bootstrap workflow through the CLI with secret-safe argument
handling, concise phase-specific output, and documentation that carries the
operator from Worker creation through initial content publication.

**Scope**

- In: subcommand metadata, option and positional validation, default secrets
  path, dependency wiring, result rendering, help text, README command list,
  Cloudflare workflow documentation, configuration documentation, and focused
  command tests.
- Out: the bootstrap domain workflow itself, interactive secret prompting,
  Worker creation, admin credential storage, automatic content publication,
  custom-domain management, and email binding support.

**Design and invariants**

- Add `cloudflare bootstrap -e <environment> [dotenv-file]`; default the path
  to `.env.<environment>.secrets`, matching `set-secrets`.
- Require Cloudflare account ID and API token through the existing static
  command metadata. Validate environment-specific Cloudflare configuration in
  the workflow after `--environment` is parsed.
- Inject the filesystem, environment reader, API-client factory, workflow, and
  output stream so tests replace no globals.
- Output may list secret names but never values or the parsed secret object.
- Resource-resolution output must use the existing configuration-path format,
  say that no version was created, and tell the operator to record IDs and
  rerun.
- Success output must identify environment, Worker, BUILD_ID, version ID,
  state path, deployment status, and Durable Object reconciliation, then give
  the exact next operational sequence: `admin accept-invite`,
  `admin create-publishing-token`, and `cloudflare release`.
- State-write failure guidance must name `recover-bootstrap-version` with the
  exact version ID.
- Documentation must explain why bootstrap is exceptional, that the first
  deployed application has APIs but no assigned site content, and that the
  command is permanently unavailable after the first remote version exists.
- Document operator precautions for hostname exposure during the short
  pre-content window and preserving the generated state file.

**Expected touch points**

- `commands/cloudflare/bootstrap.js` — CLI adapter and rendering.
- `commands/cloudflare/index.js` — bootstrap metadata.
- `test/unit-tests/commands/cloudflare/bootstrap.test.js` — help contract,
  path resolution, wiring, output, and redaction.
- `README.md` — available command list.
- `docs/cloudflare.md` — complete first-deployment and recovery runbook.
- `docs/configuration.md` — bootstrap-only secrets-file behavior and state
  requirements.

Treat this list as orientation, not permission to ignore other necessary
files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] The command is discoverable in top-level and Cloudflare help with the
  documented option and optional positional.
- [ ] The default and explicit secrets paths resolve relative to the project
  consistently with `set-secrets`.
- [ ] Output covers resource-resolution, success, remote-success/local-failure,
  and rejected-pristine-state outcomes without exposing secret values.
- [ ] Documentation provides an executable sequence from `create-worker`
  through initial `cloudflare release` and bootstrap-secret removal.
- [ ] Documentation clearly separates bootstrap from normal release safety and
  identifies email binding support as a separate prerequisite when applicable.

**Validation**

- `node run-tests.js test/unit-tests/commands/cloudflare/bootstrap.test.js test/unit-tests/commands/cloudflare/recover-bootstrap-version.test.js` — CLI behavior and output.
- `npm run lint` — all JavaScript style checks.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
