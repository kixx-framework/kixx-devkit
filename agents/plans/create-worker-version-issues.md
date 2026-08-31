# Issue Tracker: Cloudflare create-worker-version Command

This document records issues found while reviewing
`kixx.js cloudflare create-worker-version`. The issues are ordered by severity.

Severity meanings:

- **High** — can prevent the intended Worker from receiving a version without
  reporting failure.
- **Medium** — produces misleading behavior or loses supported information in a
  normal workflow.
- **Low** — does not corrupt the uploaded version, but makes the interface less
  predictable or useful.

## Order of work

1. **CWV-001 and CWV-004 together.** Both are the same failure: exit code 0, a
   message reporting success, and nothing created on Cloudflare. `shouldUpload`
   is derived from hashes of local content, but both issues are cases where
   something outside the hashed content changed — the target Worker, and the
   deployment intent. The existing `unprovisionedClasses.length > 0` term is the
   precedent for both fixes. One change to `shouldUpload`, two regression tests.

2. **CWV-003.** Worth doing, and for a broader reason than the issue records.
   `WORKER_VERSION` is destructured in the `CloudflareWorkerVersion`
   constructor, so a typo such as `compatibilty_date` is dropped silently,
   hashed, and uploaded, and the authored compatibility date never applies.
   Annotations are one instance of a general silent-drop. Put the unknown-key
   rejection in the constructor rather than in `create-worker-version.js`, so
   every caller gets it. The cost is that a newly added Cloudflare field is
   rejected until this toolkit adds it; failing loudly is the better trade here.

3. **CWV-002, partially.** The severity is overstated: `describeEntry()` falls
   back to `JSON.stringify(entry)`, so rename and transfer entries print
   everything, only unreadably. There is one real information loss — `{ class,
   message }` entries print only the message, because `entry.class` is absent
   from the name lookup chain. Add `entry.class` to that chain. Defer the
   section-aware renderers and schema fixtures until a Durable Object rename or
   transfer is actually performed, and mark that remainder deferred rather than
   open so it does not read as outstanding work.

## CWV-001: State for a previous Worker can suppress an upload

**Severity:** High

**Status:** Fixed

### Trigger

1. Create a version for an environment, producing
   `.kixx/cloudflare-state.<environment>.json`.
2. Change `environments.<environment>.WORKER.name` to another existing Worker.
3. Leave the modules, bindings, and `WORKER_VERSION` unchanged.
4. Run `create-worker-version` again without `--force`.

The state file records `workerName`, but the idempotency decision compares only
`modulesHash`, `bindingsHash`, and `configHash`. The state filename is scoped by
environment rather than Worker name.

### Implications

The command fetches and validates the newly named Worker, then reports that
nothing changed and creates no version. The local state displayed in that
message belongs to the previous Worker. The operator can therefore receive a
successful exit code while the selected Worker has never received the expected
code or bindings.

This also makes a Worker rename or an environment retarget unsafe unless the
operator knows to delete the state file or pass `--force`.

### Potential fixes

1. Treat `state.workerName !== workerName` as a changed input and upload. This
   preserves the current state-file location and output format.
2. Include the Worker name in `configHash`. This forces an upload, but hides the
   reason inside the generic configuration hash and does not protect older
   state files until their hash changes.
3. Scope state filenames by both environment and Worker name. This prevents
   collisions but changes a documented, git-tracked path and leaves stale state
   files behind after renames.
4. Reject a mismatch and require the operator to remove or migrate the state
   file. This is safe but turns a condition the command can resolve into manual
   work.

**Recommended fix:** Option 1. Make `state.workerName !== workerName` force an
upload. Preserve the existing three content hashes, state path, and
compatibility with older state files. Add a unit test which carries state
forward, changes only `WORKER.name`, and verifies that the new Worker receives a
version.

**Decided:** Report the retarget through a separate result field, not a fourth
`changes` dimension.

`changes` is a 1:1 mirror of the three hash fields in the state file. Every key
has a recorded counterpart and a uniform `old -> new` digest line in
`renderCreated()`. A Worker name is an identifier, not a digest, so it would
need its own render branch regardless of where it lives; putting it in `changes`
buys a fourth key and a special case rather than one or the other. It also
widens the meaning of `changes` from "hashes that differed" to "reasons we
uploaded", which gives `deploy` (CWV-004) an equal claim to a slot and leaves
`unprovisionedClasses` — an upload reason deliberately held outside `changes`
today — inconsistent with both.

So instead:

- Add the Worker name comparison as an override term in `shouldUpload`,
  alongside the existing `unprovisionedClasses.length > 0` term.
- Report it through a null-or-value result field carrying the previous name,
  such as `retargetedFrom: state.workerName`. This follows the shape already
  set by `forcedDeploymentClasses` and its own `renderDeployment()` renderer.
- Leave the `changes` typedef, the three-key literal in the
  `resources-resolved` early return, and `renderHashLine()` untouched.

The previous name is the fact the operator needs — it names the Worker still
holding the version they believed they had replaced — and a test can assert on
it rather than on a boolean.

`renderCreated()` must print that retarget. When a Worker name change is the
sole reason for an upload, the three hash lines all read `unchanged` and are
immediately followed by `Created version ...`, which reads as a defect in the
tool.

### Relevant code

- `lib/cloudflare/create-worker-version.js` — computes `changes` and
  `shouldUpload`.
- `lib/cloudflare/worker-version-state.js` — defines the environment-scoped
  state path and recorded `workerName`.

## CWV-002: Reconciliation output does not match Cloudflare's schema

**Severity:** Medium

**Status:** Partially fixed

`entry.class` was added to the name lookup chain in `describeEntry()`, so an
`{ class, message }` entry (`info`/`warnings`) now prints its class name
instead of the message alone.

The rest — section-aware renderers for `renamed`, `transfer_pending`, and
`transferred`, and schema fixtures for them — is deliberately deferred until a
Durable Object rename or transfer is actually performed, per the order of
work. Not open, not scheduled; `describeEntry()`'s `JSON.stringify` fallback
still covers those shapes in the meantime.

### Trigger

Deploy a version whose `exports_reconciliation` response contains any current
structured entry, including:

- `info` or `warnings` entries with `{ class, message, ... }`;
- `renamed` entries with `{ from, to }`;
- `transfer_pending` entries with `{ class, from }`; or
- `transferred` entries with `{ class, to, phase }`.

The renderer looks for `class_name`, `name`, or `export_name`. It does not read
the documented `class`, `from`, `to`, or `phase` fields.

### Implications

Informational and warning entries lose their class name and print only the
message. Rename and transfer results fall back to raw JSON. The command still
creates the version correctly, but the output obscures the exact Durable Object
affected by a warning and makes normal reconciliation output look like an
unknown response shape.

That is particularly risky for deletion, rename, and transfer work, where the
operator needs an unambiguous class or script name before editing tombstones.

### Potential fixes

1. Add section-aware renderers matching each documented reconciliation shape.
   Keep the raw JSON fallback for future unknown shapes.
2. Expand the generic name lookup to include `entry.class`, `entry.from`, and
   `entry.to`. This improves the output but cannot clearly express relationships
   such as `OldName -> NewName`.
3. Print every structured entry as JSON. This preserves information but gives up
   the command's human-oriented output.

**Recommended fix:** Option 1. Render scalar sections directly, render rename
and transfer relationships explicitly, and use a shared renderer only for the
common `info` and `warnings` shape. Test with fixtures copied from the current
Cloudflare API schema, including `referencing_scripts` and
`removable_entries`.

### Relevant code and documentation

- `commands/cloudflare/create-worker-version.js` — `renderReconciliation()`,
  `renderReconciliationEntry()`, and `describeEntry()`.
- Cloudflare API: <https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/>

## CWV-003: Unsupported WORKER_VERSION annotations are silently ignored

**Severity:** Medium

**Status:** Fixed

### Trigger

Add an `annotations` block, such as a `workers/message`, beneath
`environments.<environment>.WORKER_VERSION` and run the command.

`CloudflareWorkerVersion` supports annotations, and the entire `WORKER_VERSION`
object contributes to `configHash`. The orchestrator then replaces the supplied
`annotations` object with its generated `workers/tag` and
`workers/triggered_by` values.

The original implementation plan deliberately makes annotations command-owned,
so accepting authored annotations is not the intended contract. The defect is
that unsupported input is accepted, hashed, and ignored instead of rejected.

### Implications

The command uploads a version and exits successfully, but the requested message
does not reach Cloudflare. Editing only the ignored annotation changes
`configHash` and creates another version whose effective payload differs only in
the generated build metadata. This makes configuration appear supported when it
is not.

### Potential fixes

1. Validate `WORKER_VERSION` against its intended keys and reject `annotations`
   and all other unsupported fields with a `UsageError`.
2. Merge authored annotations with the generated annotations, with the command
   retaining ownership of `workers/tag` and `workers/triggered_by`. This adds
   support for `workers/message`, but changes the settled configuration contract.
3. Exclude unsupported fields from `configHash` while continuing to ignore them.
   This avoids redundant uploads but preserves silent misconfiguration.

**Recommended fix:** Option 1. Enforce the settled contract:
`compatibility_date`, `compatibility_flags`, `limits`, `placement`, and
`cache_options` are the supported `WORKER_VERSION` keys. Fail locally on any
other key. If authored messages are wanted later, add them deliberately through
a separately reviewed configuration field or CLI option.

**Decided:** Two checks, not one, because they guard different things.

`CloudflareWorkerVersion` is a general-purpose payload builder — `annotations`
is a legitimate constructor option for any caller, not something the class
itself can call unsupported. Its constructor now rejects any top-level option
key outside its own six (`annotations` included), which only catches typos
like `compatibilty_date` for every current and future caller; it cannot see
that `create-worker-version.js` overwrites `annotations` before the merged
object ever reaches the constructor, so it does not by itself enforce the
command-owned contract.

That enforcement is `create-worker-version.js`'s to make, because only it
knows `annotations` is disallowed in *its* `WORKER_VERSION` input.
`createWorkerVersion()` now rejects any `environments.<environment>.WORKER_VERSION`
key outside `compatibility_date`, `compatibility_flags`, `limits`, `placement`,
`cache_options` — `annotations` included — before the merge that would
otherwise discard it silently, with a `UsageError` naming the exact config
path.

### Relevant code

- `lib/cloudflare/create-worker-version.js` — hashes `WORKER_VERSION` and
  constructs the payload with replacement annotations.
- `lib/cloudflare/cloudflare-worker-version.js` — validates and serializes
  annotations supplied by callers.
- `agents/plans/create-worker-version.md` — records the command-owned annotation
  decision.

## CWV-004: An explicit --deploy can be skipped as unchanged

**Severity:** Medium

**Status:** Fixed

### Trigger

1. Upload a version without `--deploy`.
2. Preserve the resulting local state and all hashed inputs.
3. Run the command again with `--deploy` but without `--force`.

The `deploy` option affects the eventual API request but is not part of
`shouldUpload`. The command therefore takes the unchanged-input branch before it
can send `deploy=true`.

### Implications

The explicit deployment request exits successfully without creating or
deploying a version. The operator must know to combine `--force --deploy`, even
though the implementation plan states that an explicit `--deploy` always
deploys.

This is more than a help-text ambiguity: the flag expresses an external state
change which local content hashes do not represent.

### Potential fixes

1. Make `deploy` force version creation by including it in `shouldUpload`. The
   command retains its create-and-optionally-deploy model.
2. When content is unchanged, deploy `state.versionId` through the separate
   deployments API. This avoids a duplicate version but changes the command from
   “create a version” into a combined create/deploy command and relies on local
   state naming a version that still exists.
3. Keep the current behavior and document that deployment requires
   `--force --deploy` when content is unchanged. This leaves the flag's behavior
   dependent on hidden local state.

**Recommended fix:** Option 1. Treat `--deploy` as an explicit request to create
and deploy a new version, so `shouldUpload` includes `deploy`. Add a two-run test
where the first upload is undeployed and the second unchanged run with
`deploy: true` performs an API call with `deploy=true`.

### Relevant code

- `commands/cloudflare/create-worker-version.js` — defines the `--deploy`
  option.
- `lib/cloudflare/create-worker-version.js` — computes `shouldUpload` and passes
  the deployment option to the API client.
- `agents/plans/durable-object-exports.md` — records that explicit `--deploy`
  always deploys.

