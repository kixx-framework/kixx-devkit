# Implementation Plan: Durable Object exports and deploy-aware version creation

## Implementation Approach

`kixx.js cloudflare create-worker-version` cannot currently create the first
Worker version for any environment that uses a Durable Object. It aborts in
`assertNoBindingOnIntroducedClass()` with a `UsageError` claiming no
configuration change can get past it and that the class must be introduced with
another tool.

That claim is false. This plan removes it, and moves Durable Object lifecycle
management from the legacy `migrations` array to Cloudflare's declarative
`exports` field.

### Verified behavior of the Cloudflare API

Every statement below was confirmed against the real API on 2026-08-29 using
throwaway Workers on the `caddcea86b70af9ab3fab492f5eb8467` account, on the
beta endpoint this tool already calls,
`POST /accounts/{account_id}/workers/workers/{worker_id}/versions`. The scratch
Workers were deleted after each probe. Do not re-derive these; they are settled.

| Version payload | `?deploy` | Result |
| --- | --- | --- |
| `exports` + Durable Object binding on a new class | `false` | **403**, code `100406` |
| `migrations` + Durable Object binding on a new class | `false` | **403**, code `100123` |
| `exports` + Durable Object binding on a new class | `true` | **200**, namespace provisioned |
| `migrations` + Durable Object binding on a new class | `true` | **200**, `migration_tag: v1` |
| `exports`, no binding, deployed; then `exports` + binding | `true`, then `false` | **200**, then **200** |

The findings that drive this plan:

1. **`?deploy=true` creates and provisions in a single call.** Cloudflare orders
   lifecycle reconciliation before binding validation within that one operation.
   A version may both introduce a Durable Object class and bind it, provided it
   is deployed. The two-phase bootstrap the current error message describes is
   not necessary and never was.
2. **The existing guard ignores `deploy`.** It throws on the migration plan
   alone, so `--deploy` — which already exists as an option and already reaches
   `?deploy=true` — can never be exercised on a first run. The block is entirely
   self-inflicted.
3. **`exports` does not change *when* provisioning happens.** Reconciliation
   runs at deployment under both schemes; `exports` has its own error for the
   undeployed collision (`100406`) exactly mirroring `100123`. Anyone reading
   the `exports_reconciliation` response field as proof of upload-time
   provisioning is misreading it. This plan does **not** adopt `exports` to fix
   the block — finding 2 fixes the block.
4. **`deployed_on` on the Worker record is a reliable never-deployed signal.**
   `null` after Worker creation, still `null` after an undeployed version
   upload, set to a timestamp after a deployed one.
5. **`references.durable_objects` on the Worker record reports provisioned
   namespaces** as `{ worker_id, worker_name, namespace_id, namespace_name }`,
   with `namespace_name` observed as `` `${workerName}_${className}` ``. This is
   server-side truth about which classes exist.

### Why adopt `exports` at all

Not for the block. For the bookkeeping it deletes. The legacy scheme requires
this tool to maintain a shadow copy of Cloudflare's state — a recorded class
list and a monotonic `vN` tag — and to diff against it to synthesize operations.
That shadow copy can drift from reality, and the current code's answer to drift
is an error message instructing a developer to hand-edit JSON.

`exports` is declarative: the map is the desired state, Cloudflare reconciles.
There is no tag, no history, and nothing to keep in sync. Adopting it removes
`migrationTag` and `durableObjectClasses` from the state file, the `vN`
arithmetic, the recorded-versus-configured diffing, the stale-tag recovery path,
and the regex-matching in `isStaleMigrationTagError()` that exists only because
the tag-drift error shape was never confirmed.

Combined with finding 5, the tool stops guessing at Cloudflare's state and reads
it instead.

### Settled decisions

- **Every environment is greenfield.** Nothing has been deployed to any
  environment, and no Worker carries migration history. The legacy `migrations`
  path is therefore **removed outright**, not deprecated. `exports` and
  `migrations` are mutually exclusive per upload, and a Worker deployed with
  `exports` can never return to `migrations`, so this is a one-way door taken
  deliberately while it is still free.
- **`DURABLE_OBJECT_MIGRATIONS` stays** as the place to declare tombstones. The
  config key keeps its name despite no longer producing migrations; renaming a
  config key the user has settled on is churn, not clarity.
- **Named Worker entrypoints are out of scope.** The `exports` map also accepts
  `{ "type": "worker" }` entries with a per-entrypoint `cache` override. This
  plan emits Durable Object entries only. Any entry the tool did not author must
  not be assumed absent by future work.
- **New namespaces are always `"storage": "sqlite"`.** `legacy-kv` is never
  emitted; Cloudflare never provisions a new one, and no existing namespace here
  is KV-backed.
- **Auto-deploy is bounded by `deployed_on`.** See the policy below.

### The deploy policy

The condition that requires a deployment is not "first run". It is a property of
the payload, computable before upload: *this version binds a Durable Object
class whose namespace is not yet provisioned*. A version in that shape must be
deployed; one that is not, need not be.

Given that condition holds:

- **`deployed_on === null`** — the Worker has never served traffic. Deploying
  displaces nothing, so the command uploads with `?deploy=true` on its own and
  reports that it did. Requiring a flag here would be a speed bump in front of
  the only action that can succeed.
- **`deployed_on` is set** — the Worker is live. Deploying routes 100% of
  traffic to the new version, which is a production event and must be the
  developer's explicit choice. The command aborts with a `UsageError` naming
  `--deploy`.

An explicit `--deploy` always deploys, in either state. This policy is the
entire replacement for `assertNoBindingOnIntroducedClass()`.

### Determining which classes are provisioned

From `references.durable_objects` on the `getWorker()` response, which
`assertWorkerExists()` already fetches and currently discards.

`namespace_name` is derived, not declared, so treat the observed
`` `${workerName}_${className}` `` convention as a parsing hint rather than a
contract. Where the prefix matches, strip it to recover the class name. Where an
entry does not carry the expected prefix, the class name is **unknown**: treat
the class as unprovisioned rather than assuming it exists. That direction is the
safe one — it can produce a needless deploy prompt, never a silent 403 or a
wrongly skipped deployment.

### Tombstone lifecycle change

Under `migrations`, a declaration was idempotent because it applied only while
its subject remained in the recorded class list, so stale declarations could sit
in config forever at zero cost.

Under `exports` there is no recorded list to check against. A tombstone stays in
the map and Cloudflare reports it as stale on every subsequent deploy via an
`info` entry, listing it under `removable_entries`. Stale declarations remain
harmless and non-blocking, so the config still tolerates them indefinitely — but
they are now visible noise, and the command surfaces `removable_entries` so a
developer knows which are safe to delete.

### Transfers

The legacy `transferred_classes` operation expressed only the receiving side.
The `exports` field splits a transfer into two:

- Target: `state: "expecting-transfer"` with `storage` and `transfer_from`.
- Source: `state: "transferred"` with `transferred_to`.

The existing `{ action: 'transfer', from, fromScript, to }` declaration maps to
the target side. A new `{ action: 'transfer-away', className, toScript }`
declaration is added for the source side, which the legacy shape could not
express at all.

### Module layout

```
lib/cloudflare/
    cloudflare-worker-version.js     <- exports support; migration methods removed
    durable-object-migrations.js     <- deleted
    durable-object-exports.js        <- new, replaces it
    worker-record.js                 <- new, reads deployed_on and provisioned classes
    worker-version-state.js          <- migrationTag and durableObjectClasses removed
    create-worker-version.js         <- deploy policy replaces the guard
commands/cloudflare/
    create-worker-version.js         <- reconciliation and deploy reporting
```

### Open question for Task 7

The shape of a **reconciliation** failure is not yet known. The probes observed
only the pre-reconciliation binding-validation rejection, which returned a flat
`errors: [{ code, message }]` envelope with no `scenario` tag. The documented
`scenario` enum (`storage_type_mismatch`, `tombstone_delete_class_still_in_code`,
and so on) appears on `exports_reconciliation.errors`, which no probe has
provoked. Task 6 must not assume that shape; Task 7 confirms it and reopens
Task 6 if it differs.

---

### Task 1: Durable Object exports on the version payload

**Status:** Complete
**Depends on:** None
**Documentation:** This plan's Implementation Approach; `agents/docs/code-style-guide.md`; `agents/docs/code-documentation-guide.md`; https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/

**Objective**

`CloudflareWorkerVersion` emits an `exports` map instead of a `migrations`
block, and can no longer express a legacy migration at all. A payload carrying
Durable Object lifecycle intent is valid input to the beta versions API under
the declarative scheme.

**Scope**

- In: `addExport()` (or equivalent) on `CloudflareWorkerVersion`, its validation,
  its serialization in `toJSON()`, and removal of `addNewClass()`,
  `addNewSqliteClass()`, `deleteClass()`, `renameClass()`, `transferClass()`,
  `setMigrationTags()` and the private fields behind them.
- Out: deciding *what* the map contains. That is Task 2. This task owns payload
  shape and validation only.

**Design and invariants**

- Accepted entry shapes, keyed by class name, each carrying
  `type: "durable-object"`:
  - live — `storage: "sqlite" | "legacy-kv"`, optional `state: "created"`
  - deleted — `state: "deleted"`, no other fields
  - renamed — `state: "renamed"`, `renamed_to`
  - transferred — `state: "transferred"`, `transferred_to`
  - expecting-transfer — `state: "expecting-transfer"`, `storage`, `transfer_from`
- Reject field combinations Cloudflare rejects, locally and at the call site
  that made the mistake: `renamed_to` / `transferred_to` / `transfer_from` on a
  live entry, `storage` on a deleted or renamed entry, any extra field on a
  deleted entry. Failing here beats a 400 with a server-side message.
- A `renamed_to` target must differ from its map key. Whether the target exists
  as a live entry is a whole-map invariant checked in `toJSON()`, not per call.
- Emit no `exports` key at all when nothing was added. An empty map is not
  equivalent to no map, exactly as the existing code reasons about `migrations`.
- `exports` and `migrations` are mutually exclusive on upload. Since the
  migration methods are removed, this is enforced by construction rather than by
  a check — record that in the class documentation so it is not reintroduced.
- Duplicate class keys are a programming error; reject on the second call the
  way `addBinding()` rejects a duplicate binding name.

**Expected touch points**

- `lib/cloudflare/cloudflare-worker-version.js` — new export methods, removed
  migration methods, `toJSON()` changes, class documentation.
- `test/unit-tests/lib/cloudflare/cloudflare-worker-version.test.js` — new
  coverage; delete migration and tag suites.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [x] Each of the five entry shapes serializes to exactly the documented JSON.
- [x] Every prohibited field combination throws, naming the offending field.
- [x] A `renamed` entry whose target is not a live entry in the same map throws
      from `toJSON()`.
- [x] A version with no exports emits no `exports` key.
- [x] A duplicate class key throws on the second call.
- [x] No migration or tag method remains on the class, and `toJSON()` can no
      longer emit a `migrations` key.
- [x] `toJSON()` returns copied structures; mutating the result cannot affect
      the instance.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/cloudflare-worker-version.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Everything described above.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - The API is a single `addExport(className, entry)`. Task 2 emits a map keyed
    by class name, so Task 5 iterates that map and calls this once per entry.
  - `state` is normalized: an entry omitting it is stored as `state: 'created'`,
    so every downstream check reads one field and the emitted JSON is explicit.
  - `type` is optional on input (validated as `durable-object` when present) and
    always emitted, so a caller cannot mislabel an entry.
  - Allowed fields are driven by a per-state table (`EXPORT_STATES`), so a
    prohibited combination is rejected by name without a hand-written matrix.
  - "Live" for the rename-target invariant means `created` or
    `expecting-transfer`, per the plan's statement that `expecting-transfer` is
    a live entry.
  - `renamed_to === className` is rejected at the call site, not in `toJSON()`.
- Actual files changed:
  - `lib/cloudflare/cloudflare-worker-version.js`
  - `test/unit-tests/lib/cloudflare/cloudflare-worker-version.test.js`
- Validation run: `node run-tests.js test/unit-tests/lib/cloudflare/cloudflare-worker-version.test.js`
  (37 passed); `npm run lint` clean.
- Blockers: None.

---

### Task 2: Project configuration into an exports map

**Status:** Complete
**Depends on:** None
**Documentation:** This plan's Implementation Approach, especially "Tombstone lifecycle change" and "Transfers"

**Objective**

`lib/cloudflare/durable-object-exports.js` replaces
`lib/cloudflare/durable-object-migrations.js`, turning an environment's
configuration into the desired `exports` map. It is a pure projection: no
recorded state, no diffing, no tags.

**Scope**

- In: the new module, its validation of `DURABLE_OBJECT_MIGRATIONS`, the
  `transfer-away` action, and deletion of the old module and its tests.
- Out: the payload shape (Task 1), which classes are already provisioned
  (Task 3), and the deploy decision (Task 5).

**Design and invariants**

- Live entries come from configured classes, currently
  `CONTENT_STORE.durableObjectClassName`. Preserve the existing single collection
  point so a second Durable Object source is a one-line addition.
- Live entries are always `{ type: 'durable-object', storage: 'sqlite' }`.
  `legacy-kv` is never emitted.
- Declaration mapping:
  - `{ action: 'rename', from, to }` → `exports[from] = { state: 'renamed', renamed_to: to }`
  - `{ action: 'delete', className }` → `exports[className] = { state: 'deleted' }`
  - `{ action: 'transfer', from, fromScript, to }` → `exports[to] = { state: 'expecting-transfer', storage: 'sqlite', transfer_from: fromScript }`
  - `{ action: 'transfer-away', className, toScript }` → `exports[className] = { state: 'transferred', transferred_to: toScript }`
- A declaration whose key collides with a configured live class is a
  `UsageError` naming both. Under the old scheme the recorded-class check made
  this unreachable; it is reachable now and must not resolve silently.
- `expecting-transfer` is a live entry, not a tombstone. A class declared this
  way must not also be emitted as a plain live entry.
- The function returns the map plus the set of class names that are live in it,
  which Task 5 needs to decide whether a binding targets an unprovisioned class.
- The old module's central guard — a recorded class missing from config is a
  `UsageError` rather than an inferred deletion — has no equivalent here and is
  deliberately dropped. Cloudflare owns that reconciliation now and reports an
  orphaned namespace itself. Record this so it is not mistaken for a regression.
- Declaration validation (`action` is known, required fields are non-empty
  strings, entry is an object) carries over unchanged; only the actions differ.

**Expected touch points**

- `lib/cloudflare/durable-object-exports.js` — new.
- `lib/cloudflare/durable-object-migrations.js` — deleted.
- `test/unit-tests/lib/cloudflare/durable-object-exports.test.js` — new.
- `test/unit-tests/lib/cloudflare/durable-object-migrations.test.js` — deleted.

**Acceptance criteria**

- [x] A configured class with no declarations projects to a single live sqlite
      entry.
- [x] Each of the four declaration actions projects to its documented entry.
- [x] A malformed declaration throws a `UsageError` naming its index and field,
      matching the old module's message quality.
- [x] A declaration colliding with a configured live class throws.
- [x] No configured class and no declarations yields an empty map, not `null`
      and not a throw.
- [x] The returned live-class set matches the live entries in the map.
- [x] No tag, recorded-class, or diffing logic survives anywhere in the module.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/durable-object-exports.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Everything described above.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - Exported as `buildDurableObjectExports({ environmentConfig })`, returning
    `{ exports, liveClasses }`. `liveClasses` is sorted and includes
    `expecting-transfer` entries, per the plan.
  - Live entries are emitted without an explicit `state`; Task 1's
    `addExport()` normalizes the omission to `created`.
  - The collision check covers declaration-versus-declaration as well as
    declaration-versus-configured-class, since both are the same mistake.
  - The legacy "recorded but not configured" `UsageError` is gone by design.
    Cloudflare reconciles and reports the orphan; this is recorded in the
    module's own documentation so it is not mistaken for a regression.
  - `lib/cloudflare/create-worker-version.js` still imports the deleted
    `durable-object-migrations.js`, so the full suite is red until Task 5.
- Actual files changed:
  - `lib/cloudflare/durable-object-exports.js` (new)
  - `lib/cloudflare/durable-object-migrations.js` (deleted)
  - `test/unit-tests/lib/cloudflare/durable-object-exports.test.js` (new)
  - `test/unit-tests/lib/cloudflare/durable-object-migrations.test.js` (deleted)
- Validation run: `node run-tests.js test/unit-tests/lib/cloudflare/durable-object-exports.test.js`
  (12 passed); `npm run lint` clean.
- Blockers: None.

---

### Task 3: Read deployment state and provisioned classes from the Worker record

**Status:** Complete
**Depends on:** None
**Documentation:** This plan's Implementation Approach, especially "Determining which classes are provisioned"

**Objective**

`lib/cloudflare/worker-record.js` interprets a `getWorker()` response into the
two facts the deploy policy needs: whether the Worker has ever been deployed,
and which Durable Object classes already have provisioned namespaces. The tool
stops inferring Cloudflare's state from a local file.

**Scope**

- In: the new module and its parsing, including the unrecognized-namespace-name
  fallback.
- Out: fetching (the orchestrator already calls `getWorker()`), and the deploy
  decision itself (Task 5).

**Design and invariants**

- `deployed_on` is a timestamp string once deployed and `null` before. Treat
  only a non-empty string as deployed; absent, `null`, and empty all mean never
  deployed. Verified: an undeployed version upload does not set it.
- Provisioned classes come from `references.durable_objects[].namespace_name`,
  observed as `` `${workerName}_${className}` ``. Strip that exact prefix.
- An entry whose `namespace_name` lacks the prefix yields no class name. Do not
  guess, and do not throw — a Worker may legitimately reference a namespace
  owned by another script. Omitting it makes a class look unprovisioned, whose
  worst outcome is an unnecessary deploy requirement.
- `references` and `durable_objects` may be absent. Missing means none.
- Pure interpretation of a response object, with no API client dependency, so it
  is testable from fixtures.

**Expected touch points**

- `lib/cloudflare/worker-record.js` — new.
- `test/unit-tests/lib/cloudflare/worker-record.test.js` — new, with fixtures
  copied from the recorded probe responses in this plan.

**Acceptance criteria**

- [x] `deployed_on: null` reads as never deployed; a timestamp reads as deployed.
- [x] A prefixed `namespace_name` yields its class name.
- [x] An unprefixed `namespace_name` is omitted rather than throwing or being
      partially parsed.
- [x] Absent `references`, absent `durable_objects`, and an empty array all
      yield an empty class set.
- [x] A class name containing an underscore round-trips correctly.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/worker-record.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Everything described above.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - Exported as `readWorkerRecord(worker, workerName)` returning
    `{ deployed, provisionedClasses }`. `workerName` is a separate argument
    rather than read from `worker.name`, so the caller's notion of the Worker
    name is the one used to strip the prefix.
  - A `namespace_name` that is exactly the prefix with nothing after it yields
    no class name, alongside the unprefixed case.
  - `provisionedClasses` is sorted, matching Task 2's `liveClasses`.
- Actual files changed:
  - `lib/cloudflare/worker-record.js` (new)
  - `test/unit-tests/lib/cloudflare/worker-record.test.js` (new)
- Validation run: `node run-tests.js test/unit-tests/lib/cloudflare/worker-record.test.js`
  (8 passed); `npm run lint` clean.
- Blockers: None.

---

### Task 4: Remove Durable Object bookkeeping from the state file

**Status:** Complete
**Depends on:** None
**Documentation:** This plan's Implementation Approach, "Why adopt `exports`"; `test/README.md`

**Objective**

`.kixx/cloudflare-state.<environment>.json` records only what it is the
authority on — version identity and the three change-detection hashes.
`migrationTag` and `durableObjectClasses` are gone, along with the drift they
invited.

**Scope**

- In: the `WorkerVersionState` typedef, `validateState()`, and the tests.
- Out: writing the new state, which belongs to the orchestrator (Task 5).

**Design and invariants**

- Remaining fields: `workerName`, `buildId`, `versionId`, `createdAt`,
  `deployed`, `modulesHash`, `bindingsHash`, `configHash`.
- `migrationTag` moves out of `STRING_OR_NULL_FIELDS`; the
  `durableObjectClasses` array check goes entirely.
- Greenfield means no state file exists anywhere, so no migration or
  compatibility shim is warranted. An unknown key in an existing file must
  continue to be ignored rather than rejected — validation stays a check on
  known fields, not a whitelist.
- Every field remains optional in validation. That is deliberate existing
  behavior: a partial file degrades into "everything changed", which is safe.
  Do not tighten it as drive-by work.

**Expected touch points**

- `lib/cloudflare/worker-version-state.js` — typedef, validation, docs.
- `test/unit-tests/lib/cloudflare/worker-version-state.test.js` — delete the
  removed-field suites.

**Acceptance criteria**

- [x] Neither removed field appears anywhere in the module or its documentation.
- [x] A file containing the removed keys still reads without error.
- [x] Wrong types on the surviving fields still throw naming the file.
- [x] A round trip through write and read preserves the surviving fields exactly.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/worker-version-state.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Everything described above.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - `isStringArray()` went with `durableObjectClasses`; it had no other caller.
  - The "known fields, not a whitelist" and "every field optional" rules are now
    written as a comment above `validateState()` so the next agent does not
    tighten them as drive-by work.
  - A test covers reading a file that still carries both removed keys, proving
    the ignore-unknown-keys behavior rather than merely asserting it.
- Actual files changed:
  - `lib/cloudflare/worker-version-state.js`
  - `test/unit-tests/lib/cloudflare/worker-version-state.test.js`
- Validation run: `node run-tests.js test/unit-tests/lib/cloudflare/worker-version-state.test.js`
  (13 passed); `npm run lint` clean.
- Blockers: None.

---

### Task 5: Replace the guard with the deploy policy

**Status:** Complete
**Depends on:** Task 1, Task 2, Task 3, Task 4
**Documentation:** This plan's Implementation Approach, especially "The deploy policy"

**Objective**

`createWorkerVersion()` composes the new modules and decides whether a version
must be deployed, instead of refusing to upload it.
`assertNoBindingOnIntroducedClass()` and the stale-tag recovery path are gone.
Creating the first version of a Durable Object Worker succeeds.

**Scope**

- In: the orchestrator's Durable Object handling, the deploy decision, the
  upload call, the state written afterward, and the returned result shape.
- Out: how the outcome is printed (Task 6).

**Design and invariants**

- Keep `getWorker()`'s response instead of discarding it. `assertWorkerExists()`
  becomes a fetch that still converts 404 into the `create-worker` `UsageError`.
  No second request.
- A deployment is required when a `durable_object_namespace` binding names a
  class that is live in the exports map and absent from the provisioned set.
- Resolution, in order:
  1. `deploy` was passed → upload with `?deploy=true`.
  2. No deployment required → upload with the caller's `deploy` value.
  3. Required and never deployed (`deployed_on` empty) → upload with
     `?deploy=true` and report it as forced, distinctly from an explicit
     `--deploy`. The result must carry enough for Task 6 to say which classes
     forced it.
  4. Required and already deployed → `UsageError` naming the binding, the class,
     and `--deploy`. This message replaces the current one and must not repeat
     its mistake: it describes a flag the developer can pass, not a tool they
     must go find.
- The upload-changed decision loses `migrationPlan.operations !== null` as an
  input. Under `exports` the map is identical on every run, so it cannot signal
  change on its own. It must instead upload when a required deployment has not
  happened — otherwise a Worker whose first upload was skipped as unchanged
  could never provision its class. Cover this explicitly; it is the subtle
  failure mode of the change.
- The exports map participates in change detection. Fold it into the existing
  `bindings` hash or add a fourth hash — either is defensible, but a tombstone
  edit with no other change must trigger an upload. State the choice made.
- `nextState` drops `migrationTag` and `durableObjectClasses`.
- The `CreateWorkerVersionResult` typedef's `migrations` field is replaced by
  what Task 6 needs to report reconciliation. Keep `outcome`, `changes`, and the
  rest stable; unrelated churn in this shape is out of scope.
- Delete `isStaleMigrationTagError()` and `MIGRATION_TAG_PATTERNS` with the
  recovery path they serve. The open question they were built around
  (`create-worker-version.md` Task 12) is void: there is no tag.

**Expected touch points**

- `lib/cloudflare/create-worker-version.js` — the bulk of this task.
- `test/unit-tests/lib/cloudflare/create-worker-version.test.js` — replace the
  100123 guard suite at line 389 and the stale-tag suite.

**Acceptance criteria**

- [x] Introducing and binding a class with `deployed_on: null` uploads with
      `deploy: true` without the flag, and the result reports it as forced.
- [x] The same case with `deployed_on` set throws a `UsageError` naming the
      binding, the class, and `--deploy`.
- [x] An explicit `deploy` deploys in both states.
- [x] A run needing no lifecycle change and passing no flag uploads with
      `deploy: false`.
- [x] A class already in the provisioned set is not treated as introduced.
- [x] A run whose hashes are unchanged but whose required deployment has not
      happened still uploads.
- [x] A tombstone-only config edit triggers an upload.
- [x] The state written contains neither removed field.
- [x] No reference to `assertNoBindingOnIntroducedClass`, migration tags, or
      100123 survives in the module.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/create-worker-version.test.js`
- `node run-tests.js` — the full suite, since this module is the composition root.
- `npm run lint`

**Progress and handoff**

- Completed: Everything described above.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - **Change detection choice:** the exports map is folded into the existing
    `bindingsHash` (`hashValue({ bindings, exports })`) rather than given a
    fourth hash. This keeps the state file at eight fields and the result's
    `changes` shape unchanged, and a tombstone-only edit still triggers an
    upload. A test covers that case explicitly.
  - `assertWorkerExists()` is now `fetchWorker()`, returning the record. It
    still converts a 404 into the `create-worker` `UsageError`. One request.
  - The deploy decision is split in two: `findUnprovisionedBoundClasses()`
    computes the condition, `resolveDeployment()` applies the policy and is the
    only place that throws. `resolveDeployment()` runs before the skip check, so
    a live Worker with a missing namespace aborts rather than silently skipping.
  - `shouldUpload` gained `unprovisionedClasses.length > 0` in place of the
    removed `migrationPlan.operations !== null`. This is the subtle case: a
    required deployment has not happened by definition, so it must override the
    hash comparison.
  - A binding on a class the exports map does not keep live is deliberately not
    diagnosed locally — Cloudflare's own message is more precise.
  - Result typedef: `migrations` is replaced by `forcedDeploymentClasses`
    (`string[]|null`) and `reconciliation` (`result.exports_reconciliation ??
    null`). `outcome` and `changes` are unchanged. Task 6 consumes both.
  - `isStaleMigrationTagError()`, `MIGRATION_TAG_PATTERNS`,
    `assertNoBindingOnIntroducedClass()`, `classesIntroducedBy()`, and
    `applyMigrationOperations()` are all gone.
  - `commands/cloudflare/create-worker-version.js` never read `result.migrations`,
    so nothing downstream broke.
- Actual files changed:
  - `lib/cloudflare/create-worker-version.js`
  - `test/unit-tests/lib/cloudflare/create-worker-version.test.js`
- Validation run: `node run-tests.js` — 238 passed, 0 failures; `npm run lint` clean.
- Blockers: None.

---

### Task 6: Report reconciliation and deployment to the developer

**Status:** Complete
**Depends on:** Task 5
**Documentation:** This plan's Implementation Approach, "Tombstone lifecycle change" and "Open question for Task 7"; `commands/README.md`

**Objective**

The command tells a developer what Cloudflare did to their Durable Object
namespaces, and why it deployed when they did not ask it to. Stale tombstones
become visible rather than silent.

**Scope**

- In: `commands/cloudflare/create-worker-version.js` output, the `--deploy`
  option's description, and the configuration documentation for
  `DURABLE_OBJECT_MIGRATIONS`.
- Out: the reconciliation *failure* shape, which Task 7 confirms first.

**Design and invariants**

- On a successful deployed upload, `exports_reconciliation` reports `created`,
  `updated`, `deleted`, `renamed`, `transferred`, `transfer_pending`,
  `warnings`, `info`, and `removable_entries`. Print the non-empty ones only.
  A run that changed nothing must not grow noise — that is why the existing
  output is worth preserving in shape.
- `exports_reconciliation` is absent on an undeployed upload. Absent is normal,
  not an error.
- `removable_entries` names tombstones now safe to delete from config. Print
  them with the config key, so the next step is obvious.
- `info` entries can carry `referencing_scripts` — other Workers still bound to
  an affected class. Print those; removing a tombstone while non-empty orphans
  their bindings.
- When the deploy policy forced a deployment, say so and say why, naming the
  classes. A developer who omitted `--deploy` must never discover a full-traffic
  deployment only from the dashboard. This is the highest-value line of output
  in the change.
- Update the `--deploy` description: it is now required only when introducing a
  class on an already-deployed Worker.
- Document `transfer-away` and the tombstone-staleness behavior wherever
  `DURABLE_OBJECT_MIGRATIONS` is described.

**Expected touch points**

- `commands/cloudflare/create-worker-version.js` — renderers and the option.
- `commands/README.md` — if it documents this command's options.
- `test/unit-tests/` — coverage per `test/README.md` for whatever rendering
  logic is extracted as a pure function.

**Acceptance criteria**

- [x] A forced deployment prints an unmissable line naming the classes and the
      reason.
- [x] Each non-empty reconciliation section prints; empty ones are omitted.
- [x] `removable_entries` prints with the config key to edit.
- [x] `referencing_scripts` prints with its info entry.
- [x] An undeployed upload prints no reconciliation section and no warning about
      its absence.
- [x] The unchanged-run output is unchanged from today.
- [x] The `--deploy` description reflects the new policy.

**Validation**

- `node run-tests.js`
- `npm run lint`
- Manual: inspect output for a forced deploy, a normal deploy, and a skipped run.

**Progress and handoff**

- Completed: Everything described above.
- Current state: Complete.
- Remaining: Nothing. Task 7 may reopen this if the reconciliation *failure*
  shape differs from the assumption recorded below.
- Decisions and discoveries:
  - `renderResourcesResolved()`, `renderSkipped()`, and `renderCreated()` are
    now named exports of the command module so they can be unit tested as pure
    functions. The class stays the default export; the runner is unaffected.
  - Entry shapes inside a reconciliation section are not fully documented, so
    `describeEntry()` prefers `class_name`/`name`/`export_name` and
    `message`/`description`, and falls back to `JSON.stringify(entry)`. It never
    drops an entry it does not recognize.
  - **Assumption Task 7 must confirm:** a reconciliation *success* report is
    read from `result.exports_reconciliation`; nothing here reads a failure
    shape. A reconciliation failure is currently expected to surface as a thrown
    `CloudflareApiError` from the API client, which propagates unchanged. If it
    instead arrives as a 200 carrying `exports_reconciliation.errors`, this task
    reopens: the command would print a success report for a failed run.
  - `commands/README.md` documents the command contract, not per-command
    options, so it needed no change. The only place `DURABLE_OBJECT_MIGRATIONS`
    is described to a developer is the `durable-object-exports.js` module
    documentation, which now carries all four declaration shapes — including
    `transfer-away` — and the tombstone staleness behavior.
- Actual files changed:
  - `commands/cloudflare/create-worker-version.js`
  - `lib/cloudflare/durable-object-exports.js` (declaration documentation)
  - `test/unit-tests/commands/cloudflare/create-worker-version.test.js` (new)
- Validation run: `npm test` — linter clean, 247 tests passed. Output for a
  forced deploy, a normal deploy, an undeployed run, and a skipped run was
  rendered and inspected by hand; the skipped and unchanged output is
  byte-identical to today's.
- Blockers: None.

---

### Task 7: Verify against a real Worker

**Status:** Blocked
**Depends on:** Task 6
**Documentation:** This plan's Implementation Approach, "Verified behavior" and "Open question for Task 7"

**Objective**

The rewritten command is exercised end to end against a real Cloudflare account,
confirming the behaviors mocked tests cannot: that Cloudflare accepts the
`exports` map this tool builds, that the deploy policy fires correctly in both
Worker states, and what a reconciliation failure actually looks like.

This task produces no automated test. Its output is the recorded observations in
its handoff notes.

**Scope**

- In: running the command against a disposable Worker, provoking a
  reconciliation error, and recording results.
- Out: any committed fixture, and any change to `kixx/src` beyond what a run
  requires.

**Design and invariants**

- Use a disposable Worker name, not a real environment, for everything except
  the final production run. Delete it afterward. The probes for this plan used
  `kixx-probe-*` and cleaned up; do the same.
- The API token used for the probes in this plan is being rotated. Obtain
  current credentials before starting; do not expect the recorded ones to work.
- Deleting a Worker with a provisioned Durable Object namespace destroys that
  namespace's data. Only ever do this to a scratch Worker.
- **The open question to answer and record:** what does a reconciliation
  *failure* return? Provoke one — a `deleted` tombstone for a class still
  present in the bundled code (`tombstone_delete_class_still_in_code`) is the
  cheapest. Record the HTTP status, whether the failure arrives as a flat
  `errors` array or inside `exports_reconciliation.errors`, and whether a
  `scenario` tag is present. If it differs from Task 6's assumption, reopen
  Task 6.
- A failure here is a finding, not a defect in this task. Record it, reopen the
  owning task, and fix it there.

**Expected touch points**

- No source files, unless a discovery reopens a task.

**Acceptance criteria**

- [ ] A first run against a never-deployed Worker with a Durable Object creates
      the version, deploys without `--deploy`, provisions the namespace, and
      reports the forced deployment.
- [ ] `references.durable_objects` afterward contains the namespace, and its
      `namespace_name` matches the prefix convention Task 3 relies on.
- [ ] An immediate second run skips, creating no version.
- [ ] Adding a second Durable Object class to a now-deployed Worker aborts
      naming `--deploy`, and succeeds when the flag is passed.
- [ ] A rename declaration renames the namespace, and the following run reports
      the tombstone under `removable_entries`.
- [ ] A reconciliation failure is provoked, and its exact shape is recorded in
      these handoff notes.
- [ ] The original failing invocation —
      `kixx.js cloudflare create-worker-version --environment production` against
      `/Users/kris/Projects/kixx/kixx/src` — completes.
- [ ] Every scratch Worker created is deleted.

**Validation**

- The recorded observations in this task's handoff notes.
- `npm test` — clean, after any reopened task is fixed.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Blocked before starting. Tasks 1-6 are complete, `npm test` is
  clean (linter plus 247 unit tests), and the code is ready to exercise.
- Remaining: Everything described above.
- Decisions and discoveries:
  - The single most important thing to confirm is the assumption recorded in
    Task 6's handoff notes: whether a reconciliation *failure* arrives as a
    thrown `CloudflareApiError` or as a 200 carrying
    `exports_reconciliation.errors`. If it is the latter, Task 6 reopens,
    because the command would print a success report for a failed run.
  - Also confirm the `${workerName}_${className}` namespace naming convention
    Task 3 parses. If it does not hold, Task 3's fallback makes every class look
    unprovisioned, which turns every run on a live Worker into a `--deploy`
    abort rather than a silent failure.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: Requires live Cloudflare credentials for a disposable Worker. This
  plan states the token used for its own probes is being rotated, so current
  credentials must come from the user before this task can start.
