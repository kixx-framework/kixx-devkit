# Implementation Plan: Remote Worker Secrets

## Implementation Approach

Make Cloudflare Worker versions the source of truth for deployed secret values.
The repository declares the required secret *names* in `example.env.secrets`,
while secret values enter Cloudflare only through explicit secret-management
commands. Normal Worker builds no longer read `.env.<environment>.secrets`;
they inherit every declared secret from one exact recorded remote version.

Add these commands:

```sh
kixx.js cloudflare set-secret -e production SECRET_NAME
kixx.js cloudflare delete-secret -e production SECRET_NAME
kixx.js cloudflare set-secrets -e production [dotenv-file]
```

`set-secret` reads a masked value from a terminal. When stdin is not a TTY it
reads the value from stdin to support CI without exposing it in argv, shell
history, help, output, or errors. `set-secrets` defaults its optional pathname
to `.env.<environment>.secrets`. Its contents are additive: listed names are
created or replaced and omitted remote names remain unchanged. The command
never treats an absent dotenv entry as a deletion.

Every secret command creates one undeployed Worker version and updates
`.kixx/cloudflare-state.<environment>.json` only after Cloudflare succeeds.
Secret operations preserve the base version's code, plain bindings, runtime
configuration, exports, and `BUILD_ID`; they change only the requested secret
bindings. Therefore the resulting version continues to point at already
published content and can safely be promoted later through the existing
`deploy-version` guard.

Cross-cutting concerns:

- **Names are reviewed source; values are remote state.** Active assignments in
  `<project>/example.env.secrets` declare the complete required secret-name
  contract shared by every Cloudflare environment. Assignment values are
  examples for local setup and are ignored by deployment code.
- **No duplicated declaration.** Do not add required secret names to
  `cloudflare-config.js`. `example.env.secrets` is the sole declaration.
- **Strict inheritance from an exact version.** A normal build uses `inherit`
  bindings naming the state file's exact `versionId`, with Cloudflare strict
  inheritance enabled. Never inherit implicitly from `latest`.
- **Optimistic concurrency.** Before a secret mutation or inherited build, the
  tool confirms that the recorded Worker and version are still the intended
  remote base. A stale or missing state fails without writing instead of
  guessing or overwriting another workstation's work.
- **Declared-name enforcement.** Set operations reject names absent from
  `example.env.secrets`. Delete rejects an actively declared required name;
  removing or commenting out the declaration is the reviewed authorization to
  delete it remotely.
- **Secret safety.** Values must never appear in command output, errors, state,
  hashes, test failure messages, annotations, or logs. Tests use unmistakably
  fake values.
- **Atomic remote intent.** Bulk input becomes one Cloudflare request and one
  version, subject to Cloudflare's 100-operation limit. No loop of individual
  mutations may leave a partially updated secret set.
- **Local development remains independent.** Applications may continue copying
  `example.env.secrets` to `.env.<environment>.secrets`; build and release
  commands do not read that local secrets file after this work.

### State model

Extend the environment state record to distinguish the latest version identity
from the hashes copied into that version:

```json
{
    "workerName": "example-worker",
    "buildId": "existing-build-id",
    "versionId": "secret-bearing-version-id",
    "createdAt": "2026-09-15T12:00:00.000Z",
    "deployed": false,
    "modulesHash": "unchanged",
    "bindingsHash": "hash-with-secret-name-inheritance",
    "configHash": "unchanged",
    "secretNames": ["API_KEY", "SIGNING_SECRET"]
}
```

`secretNames` contains names only and is sorted. A secret mutation carries
forward the prior code/config hashes because the remote operation copies those
inputs. Its next bindings hash is calculated from the non-secret binding
definitions plus declared secret names/inheritance identity, never secret
values. A changed declaration or inheritance base must therefore trigger a
normal version upload without exposing a value.

### Cloudflare protocol boundary

Use Cloudflare's version-preserving secret mutation facility—the same semantic
operation as `wrangler versions secret put/delete/bulk`—rather than the
immediately deployed script-secret operation. The API adapter must expose one
bulk method accepting a map whose values are `secret_text` definitions or
`null`, apply version annotations identifying the devkit command, and return
the newly created version identity. Confirm the exact request and response
shape against the current official Cloudflare API documentation while
implementing the adapter; encode it in focused HTTP contract tests. If the
documented endpoint cannot guarantee an undeployed version and an unambiguous
returned version ID, stop this task as blocked rather than emulating it with
multiple non-atomic calls or selecting an untagged `latest` version.

---

### Task RS-1: Secret declaration contract and dotenv parsing

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`

**Objective**

Provide one parser-owned representation of required Worker secret names from
`example.env.secrets`, and reusable dotenv value parsing for the bulk command.
Callers can validate names without ever treating example values as deployable
values.

**Scope**

- In: separate public operations for reading declared names and reading actual
  dotenv values; identifier, duplicate, malformed-line, missing-file, and
  deterministic-order behavior.
- Out: Cloudflare API calls, command wiring, and Worker payload construction.

**Design and invariants**

- Reuse the existing minimal dotenv grammar: `NAME=value`, blank lines,
  whole-line comments, and matching outer quotes; no expansion, inline comment
  semantics, or multiline values.
- Read declarations from exactly `<project>/example.env.secrets`.
- Only active assignments declare names. Commented examples do not.
- Ignore declaration values after syntax validation. Empty example values are
  valid because only the name is contractual.
- Return unique names in lexical order. Duplicate declarations are usage
  errors naming both lines.
- Keep actual-value parsing available to `set-secrets`, including empty string
  values. Do not retain the old API assumption that both environment files
  must be read as a pair.
- A missing declaration file is a usage error for Cloudflare version and secret
  operations, naming `example.env.secrets` and explaining its role.

**Expected touch points**

- `lib/env-file.js` — refactor/export focused dotenv parsing and declaration reading.
- `test/unit-tests/lib/env-file.test.js` — declaration and actual-value contracts.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Declaration parsing returns names only, sorted, without exposing example values.
- [ ] Actual dotenv parsing preserves current supported syntax and empty values.
- [ ] Missing, malformed, invalid, and duplicate declarations produce focused `UsageError`s.
- [ ] Parsing does not require `.env.<environment>` and `.env.<environment>.secrets` as a pair.
- [ ] Tests prove example values cannot escape through the declaration result or errors.

**Validation**

- `node run-tests.js test/unit-tests/lib/env-file.test.js` — parser and declaration behavior.
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

### Task RS-2: Atomic undeployed secret-version API

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, Cloudflare Workers bulk secrets and versions API documentation

**Objective**

Expose one Cloudflare client operation that atomically creates an undeployed
version containing a set/update/delete secret patch and returns that version's
identity. This is the only module that knows the HTTP protocol.

**Scope**

- In: API client request construction, validation, annotations/tags, response
  unwrapping, and protocol-level error behavior.
- Out: declaration checking, prompts, dotenv files, state writes, and CLI output.

**Design and invariants**

- Accept one Worker name and one operation map: each key maps to a secret string
  for create/update or `null` for deletion.
- Translate strings to Cloudflare `secret_text` objects at the adapter boundary.
- Reject an empty operation map and more than 100 operations locally.
- Make one network mutation for the entire map.
- Request version-only behavior; never create or alter a deployment.
- Apply non-secret annotations identifying the invoking devkit command and a
  collision-resistant operation tag if needed for response correlation.
- Return at least `versionId` and `createdAt`; never return or retain submitted
  secret values beyond the request lifecycle.
- Do not discover the result by blindly selecting the newest version. If a
  correlation lookup is required by Cloudflare's response shape, it must use a
  unique authored tag and reject zero or multiple matches.
- Preserve `CloudflareApiError` behavior and ensure error construction does not
  serialize request bodies containing secrets.

**Expected touch points**

- `lib/cloudflare/cloudflare-api-client.js` — public atomic version-secret mutation.
- `test/unit-tests/lib/cloudflare/cloudflare-api-client.test.js` — URL, method,
  body, limits, undeployed semantics, result identity, and redaction tests.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] One request creates one undeployed version for one or many secret operations.
- [ ] Omitted names remain unchanged and `null` explicitly deletes a name.
- [ ] The returned version ID is causally tied to this request.
- [ ] No deployment endpoint is called.
- [ ] Secret values do not appear in thrown errors or returned metadata.
- [ ] Unsupported or ambiguous Cloudflare protocol behavior blocks the task rather than weakening atomicity.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/cloudflare-api-client.test.js` — HTTP contract.
- `npm run lint` — all JavaScript style checks.
- Manual sandbox check against a disposable Worker — confirm a version is
  created, traffic remains on the previous deployment, and the returned ID is
  the created version. Do not use production secrets.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: The current Cloudflare documentation says bulk
  secret updates are additive, limited to 100 operations, and create one
  version. The implementation must still verify version-only behavior and how
  the new version ID is returned before committing to the endpoint.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RS-3: Secret mutation workflow and state invariants

**Status:** Not started
**Depends on:** RS-1, RS-2
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`

**Objective**

Own the complete domain workflow for declared-name validation, stale-base
protection, atomic remote mutation, and state replacement so all three commands
share identical safety behavior.

**Scope**

- In: set/delete operation validation, remote-base verification, API call,
  next-state construction, and returned result metadata.
- Out: prompts, command argument parsing, rendering, normal Worker builds, and deployment.

**Design and invariants**

- Require `--environment`, `environments.<environment>.WORKER.name`, a valid
  state record, and a non-empty exact base `versionId` before mutation.
- Confirm the state `workerName` matches configuration and the recorded version
  still exists remotely.
- Detect intervening remote versions before writing. Use a documented remote
  version identifier/etag or compare-and-swap facility where available; never
  mutate from stale state silently.
- Set operations accept only names actively declared in `example.env.secrets`.
- Delete accepts only names absent from the active declaration and known in the
  state's `secretNames`. This makes a reviewed declaration removal a prerequisite.
- Bulk set rejects the whole request if any name is undeclared, duplicated, or
  reserved; it never submits a valid subset.
- Reserve `BUILD_ID` and `ENVIRONMENT`; neither may be managed as a secret.
- Preserve the prior `BUILD_ID`, modules hash, and config hash. Calculate the
  next bindings hash without secret values and record the sorted next
  `secretNames` set.
- Record the returned version as `deployed: false`. Write state only after the
  remote request succeeds and write the complete record atomically through the
  existing state owner.
- Return names and version metadata only; never return values.

**Expected touch points**

- `lib/cloudflare/manage-worker-secrets.js` — new shared workflow module.
- `lib/cloudflare/worker-version-state.js` — validate and document `secretNames`
  and any concurrency metadata.
- `test/unit-tests/lib/cloudflare/manage-worker-secrets.test.js` — workflow behavior.
- `test/unit-tests/lib/cloudflare/worker-version-state.test.js` — extended state contract.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Set and bulk-set are additive; unmentioned names remain in state and remotely.
- [ ] Delete requires prior removal from `example.env.secrets` and removes only the named secret.
- [ ] Undeclared, reserved, stale-base, missing-state, wrong-Worker, and unknown-delete cases fail before mutation.
- [ ] One workflow invocation performs at most one remote mutation and one state write.
- [ ] Remote failure leaves state unchanged; state failure reports that the remote version exists and gives its ID for recovery.
- [ ] State records names and exact inheritance provenance but no secret values.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/manage-worker-secrets.test.js test/unit-tests/lib/cloudflare/worker-version-state.test.js`
- `npm run lint`
- Unit tests cover single set, additive bulk set, explicit delete, every preflight
  rejection, remote failure, state-write failure, stable sorting, and redaction.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RS-4: Secret-management CLI commands

**Status:** Not started
**Depends on:** RS-3
**Documentation:** `commands/README.md`, `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`

**Objective**

Expose the three agreed Cloudflare commands with secret-safe input, concise
output, and no deployment side effects.

**Scope**

- In: command metadata, options and positionals, interactive/piped value input,
  default dotenv pathname, API client construction, workflow calls, and output.
- Out: domain mutation rules owned by RS-3 and normal build inheritance owned by RS-5.

**Design and invariants**

- Register `set-secret`, `delete-secret`, and `set-secrets` in the Cloudflare
  command index.
- Every command requires `--environment` and the standard Cloudflare account ID
  and API token from `.kixx/secrets.json`.
- `set-secret SECRET_NAME` prompts once with masking when stdin is a TTY. On a
  non-TTY it consumes stdin to EOF, strips only the terminal line ending added
  by common pipe usage, and rejects absent input. It has no value option or
  positional value.
- If supporting both terminal and pipe behavior would make `prompt.js`'s public
  contract unclear, add a focused secret-input function rather than changing
  password prompt behavior globally.
- `delete-secret SECRET_NAME` requires no secret value. It relies on RS-3 for
  the reviewed-declaration guard; do not add an interactive confirmation that
  would break CI use.
- `set-secrets [dotenv-file]` resolves a supplied relative pathname from the
  application project directory. Omission selects
  `<project>/.env.<environment>.secrets`. Missing files fail explicitly.
- Output names the environment, Worker, changed secret names, created version
  ID, preserved `BUILD_ID`, state filepath, and that the version is undeployed.
  It never prints values.
- Commands return `0` only after state is successfully recorded.

**Expected touch points**

- `commands/cloudflare/index.js` — subcommand descriptions.
- `commands/cloudflare/set-secret.js` — single-secret command.
- `commands/cloudflare/delete-secret.js` — deletion command.
- `commands/cloudflare/set-secrets.js` — additive dotenv command.
- `lib/prompt.js` or a new focused input module — safe TTY and stdin handling.
- `test/unit-tests/commands/cloudflare/*.test.js` — command contracts.
- `test/unit-tests/lib/prompt.test.js` or focused input-module tests.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Help lists all three commands with the agreed interfaces.
- [ ] Interactive single-secret input is masked; CI input works through stdin.
- [ ] Bulk input defaults correctly and an explicit pathname overrides it.
- [ ] Bulk input is applied in one workflow call and remains additive.
- [ ] Each successful command reports one undeployed version and updates state.
- [ ] No command output or error contains a supplied secret value.
- [ ] Tests prove no deployment or Publishing API call occurs.

**Validation**

- `node kixx.js cloudflare --help`
- `node kixx.js cloudflare set-secret --help`
- `node kixx.js cloudflare delete-secret --help`
- `node kixx.js cloudflare set-secrets --help`
- `node run-tests.js test/unit-tests/commands/cloudflare test/unit-tests/lib/prompt.test.js`
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

### Task RS-5: Strict remote-secret inheritance in builds and releases

**Status:** Not started
**Depends on:** RS-1, RS-3
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`, `docs/cloudflare.md`

**Objective**

Normal Worker version creation and the composed release workflow inherit the
declared secrets from the exact recorded remote version, eliminating local
secret values from deployment inputs and idempotency decisions.

**Scope**

- In: Worker binding construction, payload support for `inherit`, strict upload
  behavior, state/hash behavior, missing/stale-base failures, and release integration.
- Out: changing non-secret `.env.<environment>` behavior or secret mutation commands.

**Design and invariants**

- Continue requiring and reading `.env.<environment>` for `plain_text`
  bindings. Stop reading or requiring `.env.<environment>.secrets`.
- Read required secret names from `example.env.secrets` and emit one
  `{ type: 'inherit', name, version_id: state.versionId }` binding per name.
- Extend `CloudflareWorkerVersion` validation/serialization for `inherit`,
  requiring a non-empty exact `version_id`; do not permit the implicit
  `latest` default in this workflow.
- Send the Cloudflare strict-inheritance request option so an unresolved source
  or missing binding fails the upload instead of being silently dropped.
- Verify the state Worker matches configuration and the source version exists
  before bundling/uploading. Surface actionable bootstrap guidance when no
  source version exists.
- Detect declaration/state mismatch: every declared name must be present in
  `state.secretNames`. Extra remote names may remain but are not inherited by a
  normal build after their declaration is removed.
- Hash the deterministic inherited binding definitions and exports; never hash
  secret values. A changed declaration or source version changes the bindings hash.
- Preserve `BUILD_ID` generation and all existing content-staging/deployment
  ordering. `release` uses the same preparation path and receives no separate
  secret behavior.
- Remove tests and documentation asserting that changing a local secret value
  triggers an upload; replace them with declaration and inheritance provenance tests.

**Expected touch points**

- `lib/cloudflare/worker-bindings.js` — declared inherited secret bindings.
- `lib/cloudflare/cloudflare-worker-version.js` — `inherit` payload support.
- `lib/cloudflare/cloudflare-api-client.js` — strict inheritance request option.
- `lib/cloudflare/create-worker-version.js` — declaration/state resolution and no local secret read.
- `lib/env-file.js` — plain environment-file reading call site/API.
- `lib/release/cloudflare-release.js` — integration only if signatures change.
- Corresponding tests under `test/unit-tests/lib/cloudflare/` and
  `test/unit-tests/lib/release/`.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Normal builds and releases never open `.env.<environment>.secrets`.
- [ ] Every declared secret is inherited from the exact recorded version under strict mode.
- [ ] Missing state, wrong Worker, absent source version, or missing declared name fails before upload.
- [ ] Local secret-file value differences cannot change hashes or Worker versions.
- [ ] Declaration or inheritance-source changes participate deterministically in `bindingsHash`.
- [ ] Existing code/config idempotency, resource provisioning, Durable Object behavior, and release ordering remain intact.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/create-worker-version.test.js test/unit-tests/lib/cloudflare/worker-bindings.test.js test/unit-tests/lib/cloudflare/cloudflare-worker-version.test.js test/unit-tests/lib/release/cloudflare-release.test.js`
- `npm test` — full regression suite and lint.
- Manual disposable-Worker check: rotate a secret remotely, build from a checkout
  with a stale local `.env.<environment>.secrets`, inspect the created version,
  and confirm it inherited the rotated value without deploying traffic.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RS-6: User documentation and sample migration

**Status:** Not started
**Depends on:** RS-4, RS-5
**Documentation:** `README.md`, `docs/cloudflare.md`, `docs/configuration.md`, `commands/README.md`

**Objective**

Document the remote-source-of-truth workflow and migrate the sample guidance so
developers do not copy local secret values into deployments or mistake secret
mutation for deployment.

**Scope**

- In: command reference, declaration semantics, bootstrap/rotation/deletion
  procedures, CI input, additive bulk behavior, state/concurrency recovery,
  local-development distinction, and sample files.
- Out: unrelated application configuration or Publishing API documentation.

**Design and invariants**

- State plainly that `example.env.secrets` declares required names globally
  across Cloudflare environments; values are examples only.
- Explain the reviewed deletion sequence: remove/comment declaration, commit,
  run `delete-secret`, then create/release the next normal version as needed.
- Explain bootstrap: establish a base Worker version/state, set every declared
  secret, then create/release a normal version that inherits them. Document the
  exact implemented recovery command or procedure for missing/stale local state.
- Show masked terminal use and stdin CI use without examples that place values in argv.
- State that all three commands create undeployed versions and that
  `deploy-version` remains the explicit promotion step.
- Replace documentation saying builds bind values from
  `.env.<environment>.secrets`; retain its local-development purpose.
- Update the sample's transient `ADMIN_BOOTSTRAP_TOKEN` guidance so its
  declaration/removal lifecycle is unambiguous.

**Expected touch points**

- `README.md` — command inventory if appropriate.
- `docs/cloudflare.md` — full command and build/release behavior.
- `docs/configuration.md` — source-of-truth and file roles.
- `tmp/sample-app/example.env.secrets` or maintained equivalent — declaration comments.
- Help descriptions in `commands/cloudflare/index.js` if documentation review finds drift.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Documentation contains no claim that normal builds upload local secret values.
- [ ] All commands, defaults, additive semantics, undeployed behavior, and guards are documented.
- [ ] Bootstrap, rotation, deletion, stale-state recovery, local development, and CI each have an actionable procedure.
- [ ] The sample uses `example.env.secrets` as the declared-name contract and explains transient secrets.

**Validation**

- `rg -n "\.env\.<environment>\.secrets|example\.env\.secrets|set-secret|delete-secret|set-secrets" README.md docs commands tmp/sample-app` — review every user-facing reference.
- Run every command's `--help` form and compare it with `docs/cloudflare.md`.
- `npm test` — final full verification.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
