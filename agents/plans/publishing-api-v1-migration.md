Publishing API v1 Migration
============================

Migrate the devkit's publishing and release commands onto Publishing API v1
(`tmp/publishing-api.md`). This supersedes the mechanics built in
`agents/plans/publishing-and-release.md` (complete, historical): the closure/
build-id-coupled model that plan implemented no longer exists server-side and
must be replaced, not extended. Neither this CLI nor the target Kixx runtime
has ever been released, so nothing here needs a compatibility shim or a
deprecation window.


Implementation Approach
------------------------

### What actually changed

The old API committed content and assigned it to a build in one call
(`PUT /index/closure`, keyed by `buildId`, no precondition). Publishing API v1
splits this into two independent, composable primitives:

- **Release** (`POST /releases`): an immutable, fully verified manifest,
  identified by its own content hash. Creating one never touches any build.
- **Build pointer** (`PUT /builds/:buildId`): assigns an existing Release to a
  build id, gated by a mandatory `If-Match`/`If-None-Match` precondition.

Every downstream design decision in this plan follows from keeping these two
operations genuinely separate, because that separation is what the new API
uses to make pre-staging, rollback, and code-only deploys the same operation
with different arguments (see the four workflows in `tmp/publishing-api.md`).

### Addressing format is not assumed compatible

`tmp/publishing-api.md`'s discovery response reports `"addressingFormat": 3`.
The devkit's `lib/publishing/addressing.js` pins `FORMAT = 2` against an
earlier upstream port. A locally computed object id that does not match the
server's format fails every upload with `422 ObjectIdMismatch` and every
Release with `422 MissingContentObjects` — silently, since neither error
distinguishes "wrong format" from "genuinely missing". This must be verified
and re-ported before any other task depends on it (Task APIV1-1).

### Object layer becomes generic

Today's client has one stat/upload method pair per resource kind
(`statStaticAsset`, `uploadPageMetadata`, ...), each its own endpoint. The v1
object layer is generic and content-addressed: `POST /objects/status` (batched,
capped at 100 ids) and `PUT /objects/:objectId`. Resource *kind* now shows up
only in the manifest shape sent to `POST /releases` — the existing
`makeContentTree()`-style logic in `publish-content.js` is repurposed to build
that manifest, not to drive per-kind network calls.

### Bootstrap ceremony disappears

`--bootstrap` existed because the old resource `PUT`/stat handlers required an
existing closure to open a snapshot against, so a virgin build had to receive
an empty closure first. Release creation in v1 never resolves a build at all,
so this constraint is gone. The only remaining "first assignment" case is
`PUT /builds/:buildId` with `If-None-Match: *`, which is not a content
operation and needs no empty-manifest ceremony.

### Preconditions are mandatory, not optional

Every `PUT /builds/:buildId` must carry exactly one of `If-Match` or
`If-None-Match`. `412 BuildPointerConflict` means something else moved the
pointer concurrently and must stop and surface to the operator, never
auto-retry (`tmp/publishing-api.md`, Rollback workflow note). This is a new
failure mode the current client and commands have no concept of.

### Discovery replaces application state

`app-state.js`'s `liveBuildId`/`builds[buildId].closureHash` exists today
because the old API gave the client no authoritative way to discover the
running build or ask what a build serves. Publishing API v1 now answers both:
discovery reports `runningBuildId`, while `GET /builds/:buildId` returns that
build's current Release and `ETag`. Publishing and deployment decisions use
those responses directly; a checkout-local hint is too stale for either job.

`lib/app-state.js` and its publish/deploy bookkeeping are therefore removed,
not retained as a cache. `worker-version-state.js` remains: it records the
Cloudflare version artifact created by this checkout and is not a source of
publishing truth. `commands/cloudflare/release.js`'s
`isPendingDeployment`/`isBootstrapRecovery`/`isBootstrapDeployment` branching
is removed rather than adapted.

Discovery is also the compatibility handshake for every content operation.
Before checking or uploading objects, the operation verifies the server's
`contentContractVersion` and `addressingFormat` against the versions this
client supports and uses the reported limits. An incompatible server fails
before any write.

### Command vocabulary follows the API's own decomposition

- `app create-release` — scan, diff against the object store, upload, and
  `POST /releases`. Under `--dry-run` it performs discovery and the object
  status diff only: no upload, validation, Release creation, or assignment.
  Never touches a build.
- `app assign-build` — read the current pointer's `ETag` (or use
  `If-None-Match: *` for a never-assigned build), `PUT /builds/:buildId`.
  `--reason` passes through `publish` (default), `rollback`, `carry-forward`,
  or `restore`.
- `app rollback` — lists Releases/activations for an environment's build, then
  calls the same assign-build operation with `reason: 'rollback'` and an
  earlier release id. No code or deployment involvement.
- `app publish` survives as the common-case convenience: create a Release and
  immediately assign it to the explicit build id or the `runningBuildId`
  reported by discovery. It is a thin composition of the two library
  operations above, not a third implementation.
- `cloudflare release` first prepares and freezes the exact Worker artifact
  without uploading it. A skipped version becomes a content-only publish to
  discovery's `runningBuildId`; a version that must be created gets a new build
  id, a staged and verified Release, and only then an upload/deploy. The deploy
  is the only activation step, matching `tmp/publishing-api.md`'s workflow #2.

### Ownership (updated from the prior plan)

- `lib/publishing/` stays deployment-target-neutral: object addressing,
  content scanning, the manifest builder, the Publishing API client, Release
  creation, and build-pointer assignment.
- `lib/cloudflare/` keeps owning Cloudflare version preparation, upload, and
  deployment. It does not call the Publishing API.
- `lib/release/` owns workflows which coordinate publishing with a deployment
  target: the Cloudflare release transaction and the pre-deploy build-pointer
  guard.
- Command modules stay wiring, per `commands/README.md`.

### Testing

`test/unit-tests/` mirrors the source tree; see `test/README.md`. Run with
`node run-tests.js` and lint with `npm run lint`. A sample Kixx application
at `tmp/sample-app/` (git-ignored) can serve a real Publishing API v1 on
`localhost:2026` for end-to-end verification once it is updated to the new
contract — confirm with the user whether that update is in scope before
relying on it for any task's validation.


Tasks
-----

### Task APIV1-1: Re-verify object addressing against v1

**Status:** Complete
**Depends on:** None
**Documentation:** `tmp/publishing-api.md` (Discovery section); current upstream Kixx addressing source (ask the user where `addressingFormat: 3` is implemented if it is not under `tmp/sample-app/`)

**Objective**

Object ids the devkit computes locally are byte-for-byte identical to the ids
the v1 server computes for the same content. Every other task that uploads an
object or builds a manifest depends on this being true; if it is silently
wrong, uploads fail with `422 ObjectIdMismatch` and Releases fail with
`422 MissingContentObjects`, and nothing else in this plan can be trusted to
work end-to-end.

**Scope**

- In: Confirming whether `addressingFormat: 3` changes the digest algorithm,
  domain bytes, base32 alphabet, or truncation length versus the currently
  pinned `FORMAT = 2`; updating `lib/publishing/addressing.js` and its fixed
  test vectors if it has; documenting the new format number and its source.
- Out: Pathname/layout rules in `lib/publishing/content-layout.js` (unaffected
  unless the user says otherwise) and anything about the object-store client
  (APIV1-2).

**Design and invariants**

- `FORMAT` (or its v1 equivalent) is a documented constant, not an inferred
  value — same policy as the current module comment.
- If format 3 is a strict superset or unrelated versioning bump (the manifest
  and error vocabulary changed but the digest did not), say so explicitly in
  the module comment and leave the digest code alone; do not assume without
  checking against the real upstream source.
- Regenerate fixed test vectors from the upstream implementation, not by hand.

**Expected touch points**

- `lib/publishing/addressing.js`
- `test/unit-tests/lib/publishing/addressing.test.js`

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [x] The devkit's object-id computation is confirmed identical to the v1
      server's for a fixed set of vectors, or corrected to match.
- [x] The module comment names the confirmed format number and where it was
      verified against.
- [x] Every other task in this plan can rely on locally computed object ids
      matching the server without re-deriving this itself.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/addressing.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Ported addressing format 3, regenerated fixed upstream vectors, and updated the content scanner to use the unified blob hash.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: `tmp/sample-app/kixx/content-addressable-store/addressing.js` is the verified upstream source. Format 3 merges strings and ArrayBuffers into byte-addressed domain `0x00`; the same UTF-8 bytes now produce the same object id regardless of input representation.
- Actual files changed: `lib/publishing/addressing.js`, `lib/publishing/scan-content-sources.js`, `lib/publishing/content-layout.js`, `test/unit-tests/lib/publishing/addressing.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/publishing/addressing.test.js test/unit-tests/lib/publishing/scan-content-sources.test.js` passed 13 tests; `npm run lint` passed.
- Blockers: None.


### Task APIV1-2: Generic object-store client

**Status:** Complete
**Depends on:** None
**Documentation:** `tmp/publishing-api.md` (Discovery, Check which objects are already stored, Upload an object)

**Objective**

The devkit can ask the v1 server which of a batch of object ids it already
holds, and can upload one object, using the generic content-addressed
endpoints — replacing the per-resource-kind stat/upload method pairs the
client has today.

**Scope**

- In: `GET /` discovery (contract version, addressing format, limits);
  `POST /objects/status` with client-side batching at `maxObjectStatusIds`
  (100) and deduplication; `PUT /objects/:objectId` raw-byte upload; removing
  every `stat*`/`upload*` per-resource-kind method from
  `lib/publishing/publishing-api-client.js`.
- Out: Release and build-pointer endpoints (APIV1-3). Deciding which objects
  to check or upload, or building any manifest (APIV1-4).

**Design and invariants**

- One instance per publish, constructed with origin and token, matching the
  current client.
- Discovery is an explicit first operation, not a hidden request made by an
  arbitrary client method. It returns one capabilities record which the
  calling workflow reuses for compatibility checks, batching, and size limits.
- Retry policy unchanged in shape: network errors, `429`, `5xx` retried with
  jittered backoff up to the existing attempt cap; other `4xx` fail
  immediately.
- `413 PAYLOAD_TOO_LARGE_ERROR` and `422 ObjectIdMismatch`/`ObjectIdInvalid`
  are reported as themselves, not retried.
- The 100-id status cap and 25 MiB object cap are enforced client-side before
  the request, using the limits `GET /` reports, so a caller gets a clear
  local error instead of a server rejection.
- The token must never appear in an error message, log line, or thrown error
  — unchanged invariant from the current client.
- `PUT /objects/:objectId` has no required media type and no JSON:API
  envelope — raw bytes only, exactly like the current static-asset upload.

**Expected touch points**

- `lib/publishing/publishing-api-client.js`
- `test/unit-tests/lib/publishing/publishing-api-client.test.js`

**Acceptance criteria**

- [x] Discovery returns the parsed limits and format/version fields.
- [x] No object write occurs before the calling workflow has had an
      opportunity to reject an unsupported contract or addressing format.
- [x] A status check batches more than 100 requested ids into multiple
      requests and deduplicates before sending.
- [x] A status check reports exactly which of the requested ids are stored,
      with no promised order assumed.
- [x] An upload distinguishes newly-stored (`201`) from already-present
      (`200`) and returns the stored size.
- [x] A body over `maxObjectBytes` is rejected locally before any request.
- [x] Every per-resource-kind method is removed from the client. The legacy
      dynamic method-name references remain isolated in `publish-content.js`
      until APIV1-4 rewrites that workflow; APIV1-4 owns making the final grep
      clean so these tasks do not form a dependency cycle.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/publishing-api-client.test.js`
  against an injected fetch implementation.
- `npm run lint`

**Progress and handoff**

- Completed: Added explicit discovery, deduplicated and limit-batched object status checks, and size-limited raw object uploads; removed the old per-resource and closure methods from the client.
- Current state: Complete.
- Remaining: Nothing. APIV1-4 subsequently replaced the isolated legacy workflow references.
- Decisions and discoveries: Limits are explicit method options populated from discovery so the client never hides a discovery request or selects compatibility policy. `getObjectStatus()` returns stored `{ objectId, size }` records without promising order. `uploadObject()` returns `created` to preserve the `201`/`200` distinction. The old `publish-content.js` dispatch map still names every per-resource method; the acceptance criterion was clarified so APIV1-2 removes the client surface and APIV1-4 removes those isolated dynamic references while replacing the workflow, avoiding a dependency cycle.
- Actual files changed: `lib/publishing/publishing-api-client.js`, `test/unit-tests/lib/publishing/publishing-api-client.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/publishing/publishing-api-client.test.js` passed 11 tests; `npm run lint` passed; client method grep passed with no matches. APIV1-4 later made the repository-wide legacy method grep clean.
- Blockers: None.


### Task APIV1-3: Release and build-pointer client methods

**Status:** Complete
**Depends on:** APIV1-2
**Documentation:** `tmp/publishing-api.md` (Create a Release, Verify a Release without publishing it, Release history, Build pointers, Assign a Release to a build, Build activation history)

**Objective**

The devkit can create and validate Releases, read Release and build-pointer
history, and assign a Release to a build under the mandatory precondition
protocol — as a distinct, independently reviewable capability from moving
bytes into the object store (APIV1-2), because the invariants are different:
Release creation is a multi-step server-side verification pipeline, and
build-pointer assignment is a compare-and-swap with three distinct failure
shapes (`404`, `412`, `428`).

**Scope**

- In: `createRelease(manifest, provenance)`, `validateRelease(manifest)`
  (rejects inline content locally before sending, per the API's own rule),
  `listReleases({ limit, cursor })`, `getRelease(releaseId)`,
  `getReleaseManifest(releaseId)`, `listBuilds()`, `getBuild(buildId)`
  (returning the release id and the `ETag`), `assignBuild(buildId, releaseId,
  { ifMatch, ifNoneMatch, reason })`, `getBuildActivations(buildId, { limit,
  cursor })`.
- Out: Deciding *when* to call these (APIV1-4, APIV1-5, APIV1-7, APIV1-8).
  Object status/upload (APIV1-2).

**Design and invariants**

- `assignBuild` requires exactly one of `ifMatch`/`ifNoneMatch` from its
  caller — the client does not invent a default, matching the API's refusal
  of an unconditional form. Passing both or neither is a programmer error in
  this codebase, not a server round trip; assert it locally.
- `404 BuildNotFound`, `404 ReleaseNotFound`, `412 BuildPointerConflict`,
  `422 InvalidBuildAssignment`, and `428 PreconditionRequired` are each
  surfaced as distinctly typed/named failures (following
  `lib/publishing/publishing-api-error.js`'s existing pattern), because
  callers in APIV1-5/7/8 must branch on them differently — `412` must never be
  retried automatically.
- Assigning the release a build already points at is documented as a
  success no-op; the client returns it as an ordinary success, not a special
  case the caller must detect.
- `POST /releases/validation` with any inline content in the manifest is
  rejected client-side with a clear message, since the server also rejects it
  but only after a round trip.
- `contentContractVersion`/`addressingFormat` mismatches from discovery
  (APIV1-2) are enforced by the content workflow in APIV1-4 before it calls
  these methods. The transport client reports capabilities; it does not choose
  application compatibility policy.

**Expected touch points**

- `lib/publishing/publishing-api-client.js`
- `lib/publishing/publishing-api-error.js`
- `test/unit-tests/lib/publishing/publishing-api-client.test.js`

**Acceptance criteria**

- [x] Creating a Release with a byte-identical manifest to one already created
      returns the original record (content-idempotence is a server property;
      confirm the client doesn't do anything that breaks it, e.g. sending
      spurious idempotency keys).
- [x] `validateRelease` never persists anything and rejects inline content
      locally.
- [x] `assignBuild` throws distinctly for `404`, `412`, and `428`, and asserts
      locally when given both or neither precondition.
- [x] `getBuild` returns the `ETag` alongside the release id.
- [x] Release/build/activation history calls thread `limit`/`cursor` through.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/publishing-api-client.test.js`
  against an injected fetch implementation, covering every new error path.
- `npm run lint`

**Progress and handoff**

- Completed: Added Release creation/validation/read/history methods, build pointer read/list/assignment/history methods, pagination, ETag propagation, local assignment precondition enforcement, local inline-content rejection, and typed protocol failures.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: The shared response layer now retains JSON:API resource ids and meta plus the HTTP ETag. Public methods return semantic records (`releaseId`, `buildId`, `activationId`) rather than raw JSON:API resources. Error specialization uses JSON:API error codes because `BuildNotFound` and `ReleaseNotFound` share HTTP 404. Release creation deliberately sends no idempotency header because the server derives idempotence from content.
- Actual files changed: `lib/publishing/publishing-api-client.js`, `lib/publishing/publishing-api-error.js`, `test/unit-tests/lib/publishing/publishing-api-client.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/publishing/publishing-api-client.test.js` passed 19 tests; `npm run lint` passed; full `node run-tests.js` passed 385 tests.
- Blockers: None.


### Task APIV1-4: Manifest-building publish pipeline

**Status:** Complete
**Depends on:** APIV1-1, APIV1-2, APIV1-3
**Documentation:** `tmp/publishing-api.md` (Create a Release, the atomic release model)

**Objective**

Given scanned content sources and a client, the devkit produces a v1 manifest
naming every current resource, uploads exactly the objects the server does not
already hold, and creates a Release without resolving or mutating any build
pointer. An optional intended-build provenance hint remains non-binding. Under
`--dry-run` it reports the server-backed object diff without making any write.
This replaces
`lib/publishing/publish-content.js`'s closure-commit model.

**Scope**

- In: Building the nested manifest tree (`staticAssets`, `globalTemplatePartials`,
  `baseTemplates`, `pages.<path>.{metadata,partials,includes,templates}`,
  `emails`) with `{ objectId, size }` references and optional `mediaType`;
  batched object-status checking; bounded-concurrency upload of misses;
  `createRelease` call; optional `provenance`
  (`sourceRevision`, `message`, `client`, `intendedForBuildId`); the structured
  result a caller renders.
- Out: Assigning the resulting release to any build (APIV1-5). Reading
  environment configuration or resolving the running build (APIV1-6). Command
  wiring (APIV1-7, APIV1-8).

**Design and invariants**

- No bootstrap ceremony: this path is identical whether or not any build has
  ever been assigned a Release. Remove `--bootstrap`'s empty-closure-first
  sequence entirely rather than adapting it.
- Order: scan and validate locally (unchanged from PUB-2/PUB-3), discover the
  server contract, reject an unsupported `contentContractVersion` or
  `addressingFormat`, batch-check object status using the reported limit,
  upload misses within the reported size limit, build the manifest from the
  *complete* local tree (a manifest is a full replacement, never a merge with
  what's live), and create the Release.
- `--dry-run` scans and hashes locally, then still calls the batched
  `POST /objects/status` check so the reported diff reflects server truth
  (which resources would actually upload vs. already exist). It makes no
  `PUT` and no Release or build request. This is deliberately a no-write
  preview, not the API's server-side Release validation operation.
- `POST /releases/validation` remains available through the client for CI
  callers which have already uploaded every referenced object. It is not
  conflated with `--dry-run`, because validating a tree containing new objects
  first requires persisting those otherwise inert objects.
- Concurrency bounded the same way the current upload phase is (6 in flight).
- Any failure aborts before Release creation; existing content and any
  existing Release/build pointer are untouched. Uploaded objects from an
  aborted attempt remain content-addressed, inert, and safe to retry.
- The result carries: matched/uploaded counts and resources, unmatched files,
  and — on success — the release id, `objectCount`, `totalBytes`, and
  `contractVersion` from the response.
- Publishing the same tree twice is Release-content-idempotent (same release
  id returned) but this task never assigns it anywhere; that repetition is
  cheap and expected.

**Expected touch points**

- `lib/publishing/publish-content.js` (rewritten; consider renaming to reflect
  "build and create a Release" rather than "commit a closure" — flag the
  rename for review since it's user-facing only through the result shape, not
  a public name)
- `test/unit-tests/lib/publishing/publish-content.test.js`

**Acceptance criteria**

- [x] An unsupported content contract or addressing format fails before any
      object or Release write.
- [x] An unchanged tree makes no uploads and still creates a Release naming
      every current resource.
- [x] A changed resource uploads; unchanged siblings do not.
- [x] The manifest sent to `createRelease` never references a resource absent
      from the current local scan (no accidental inheritance from a prior
      run).
- [x] `--dry-run` performs discovery and the batched `POST /objects/status`
      check but makes no write or Release-validation request.
- [x] An upload failure prevents Release creation.
- [x] Concurrency never exceeds the existing bound.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/publish-content.test.js`
  against a fake client.
- `npm run lint`

**Progress and handoff**

- Completed: Replaced the closure workflow with discovery, compatibility checks, server-backed object status, bounded generic uploads, complete manifest construction, and immutable Release creation. Removed bootstrap behavior and every legacy per-resource client reference.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: Decided with the user: `--dry-run` performs the
  network object-status check (reports a real diff) but no upload or Release
  call. Structured scanner payloads must be canonicalized again for raw upload
  because their object ids were computed from canonical JSON bytes. The server
  manifest validator requires leading-slash logical pathname keys and template
  filenames nested below their page. Missing objects are deduplicated by object
  id before upload; operator-facing matched/uploaded counts remain resource
  counts.
- Actual files changed: `lib/publishing/publish-content.js`, `test/unit-tests/lib/publishing/publish-content.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/publishing/publish-content.test.js` passed 7 tests; full `node run-tests.js` passed 385 tests; `npm run lint` passed; repository-wide legacy client method grep passed with no matches.
- Blockers: None.


### Task APIV1-5: Build-pointer assignment operations

**Status:** Complete
**Depends on:** APIV1-3
**Documentation:** `tmp/publishing-api.md` (Build pointers, Assign a Release to a build, Rollback and Code-only deploy workflows)

**Objective**

Given an environment, a build id, and a release id, the devkit can either
compare-and-swap that build's current pointer or require that the build has
never been assigned. These are distinct policies: ordinary publish/rollback
may update a known pointer, while pre-staging must never reinterpret a build-id
collision as permission to overwrite that build.

**Scope**

- In: `lib/publishing/assign-release.js` (or similar): a compare-and-swap
  operation which reads the current pointer and uses its `ETag` (falling back
  to `If-None-Match: *` only when the build is genuinely unassigned), plus a
  first-assignment operation which always uses `If-None-Match: *` and never
  falls back to `If-Match`; return the resulting Build resource and `ETag`.
- Out: Deciding which release id to assign (APIV1-7's `app assign-build`/
  `app rollback`, APIV1-8's pre-staging flow). Any Cloudflare concern.

**Design and invariants**

- Never assigns unconditionally. The compare-and-swap form uses
  `If-None-Match: *` for a missing pointer and `If-Match` on the `ETag` it just
  read for an existing pointer.
- The first-assignment form sends `If-None-Match: *` directly. A `412` means
  the future build id is already registered and must stop the release; it must
  not read that pointer and retry with `If-Match`.
- A `412` from this operation propagates as a distinct, clearly worded error
  telling the caller something else moved the pointer concurrently and that a
  blind retry would overwrite that change — this is operator-facing text, not
  just an error code.
- Assigning the release a build already points at is treated as ordinary
  success (per the API's documented no-op-success behavior), so retry-after-
  lost-response is safe by construction.
- The compare-and-swap form makes one `GET` and one `PUT`; the first-assignment
  form makes one `PUT`. Neither polls or performs a verification `GET` after
  the write. The Cloudflare release workflow owns its additional pre-deploy
  verification read.

**Expected touch points**

- `lib/publishing/assign-release.js`
- `test/unit-tests/lib/publishing/assign-release.test.js`

**Acceptance criteria**

- [x] Assigning to a never-assigned build uses `If-None-Match: *`.
- [x] Assigning to an already-assigned build reads its `ETag` first and uses
      `If-Match`.
- [x] First-assignment mode never overwrites an existing build pointer and
      never retries its `412` with `If-Match`.
- [x] A `412` propagates as a distinct error naming the conflict, with no
      retry attempted by this module.
- [x] Re-assigning the same release id the build already points at succeeds
      without error.
- [x] `reason` passes through unmodified to the API call.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/assign-release.test.js`
  against a fake client.
- `npm run lint`

**Progress and handoff**

- Completed: Added compare-and-swap assignment and first-assignment-only operations with focused interaction and conflict tests.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: The compare-and-swap operation treats only typed `BuildNotFoundError` as an unassigned build; all other read failures propagate. The first-assignment operation issues its conditional PUT directly and never reads or falls back. Both operations wrap typed conflicts with an operator-facing warning while preserving protocol metadata and the original error as the cause.
- Actual files changed: `lib/publishing/assign-release.js`, `test/unit-tests/lib/publishing/assign-release.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/publishing/assign-release.test.js` passed 5 tests; `npm run lint` passed; full `node run-tests.js` passed 390 tests; `git diff --check` passed.
- Blockers: None.


### Task APIV1-6: Authoritative build resolution and deployment guard

**Status:** Complete
**Depends on:** APIV1-2, APIV1-3
**Documentation:** `tmp/publishing-api.md` (Discovery, Build pointers)

**Objective**

Every decision about the running build or whether a Worker build is safe to
deploy comes from Publishing API v1, and the obsolete checkout-local
application state is removed. Cross-system safety policy has an explicit owner
without making the Cloudflare library depend on the Publishing API.

**Scope**

- In: A publishing helper which resolves `runningBuildId` from discovery; a
  `lib/release/` pre-deploy operation which verifies a Worker version's
  `BUILD_ID` has a build pointer before delegating the traffic change to
  `lib/cloudflare/`; removing `lib/app-state.js` and every read/write of
  `.kixx/app-state.<environment>.json`; updating affected command output and
  tests.
- Out: Preparing and creating a new Worker version and the full Cloudflare
  release transaction (APIV1-8). `worker-version-state.js`, which continues to
  record Cloudflare artifact identity rather than publishing state.

**Design and invariants**

- Build-id resolution for content-only publishing is: an explicit
  `--build-id`, otherwise discovery's `runningBuildId`. `null` produces a
  `UsageError` explaining that the target server has no runtime build id.
- The deployment coordinator obtains the target version's `BUILD_ID` through
  the Cloudflare library, verifies it with `getBuild(buildId)`, and only then
  delegates the deployment. `404 BuildNotFound` is the refusal case.
- `--force` may bypass the Publishing API preflight when the API is
  unavailable or the operator has independent knowledge. The result and output
  still record that the guard was bypassed.
- `lib/cloudflare/` may expose a prepared-deployment value or accept a generic
  pre-deploy assertion callback, whichever best fits its existing operation.
  It must not construct or call a Publishing API client itself.
- Cloudflare's traffic change remains the commit point. Failure to write any
  local Cloudflare state after that point is reported accurately, but no
  application-state file is recreated.
- Removing app state includes `recordPublishedBuild`, `recordLiveBuild`, and
  `hasPublishedBuild`; no compatibility migration is required because the CLI
  has not been released.

**Expected touch points**

- `lib/app-state.js` — remove
- `lib/publishing/resolve-running-build.js` (or similar)
- `lib/release/deploy-cloudflare-version.js` (or similar)
- `lib/cloudflare/deploy-worker-version.js`
- `lib/cloudflare/create-worker-version.js`
- `commands/cloudflare/deploy-version.js`
- Existing publishing and Cloudflare command output which mentions app state
- Corresponding tests under `test/unit-tests/lib/` and
  `test/unit-tests/commands/cloudflare/`

**Acceptance criteria**

- [x] An omitted build id resolves from authenticated discovery, never a local
      file.
- [x] A discovery response with `runningBuildId: null` fails before any
      content write.
- [x] A deployment is refused when the target version's build id has no
      Publishing API pointer, with `--force` remaining an explicit override.
- [x] No module under `lib/cloudflare/` imports or constructs a Publishing API
      client.
- [x] `lib/app-state.js`, its tests, and all application-state reads/writes and
      output are removed; grep finds no remaining caller.
- [x] `worker-version-state.js` remains limited to Cloudflare artifact state.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing test/unit-tests/lib/release test/unit-tests/lib/cloudflare/deploy-worker-version.test.js test/unit-tests/commands/cloudflare/deploy-version.test.js`
- `rg 'app-state|recordPublishedBuild|recordLiveBuild|hasPublishedBuild|readAppState' commands lib test/unit-tests`
  returns no stale caller or application-state expectation.
- `npm run lint`

**Progress and handoff**

- Completed: Added discovery-backed running-build resolution and a release-layer Publishing API deployment guard with explicit force bypass; made the Cloudflare deployment primitive accept a generic pre-deploy assertion; removed all application state code, writes, output, and tests.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: Application state is removed; discovery and
  build-pointer reads are the only publishing authorities. Cross-system deploy
  policy belongs in `lib/release/`, not `lib/cloudflare/` or a command module.
  `lib/cloudflare/deploy-worker-version.js` exposes a generic
  `assertBuildIsPublished` callback after reading the target version's actual
  `BUILD_ID` and before changing traffic. `--force` bypasses Publishing API
  client construction and the result records `guardBypassed: true`. The
  validation command's listed `deploy-worker-version.test.js` does not exist;
  coordinator and command tests cover that boundary instead.
- Actual files changed: `lib/app-state.js` (removed), `lib/publishing/resolve-running-build.js`, `lib/publishing/publish-application-content.js`, `lib/release/deploy-cloudflare-version.js`, `lib/cloudflare/deploy-worker-version.js`, `lib/cloudflare/create-worker-version.js`, `commands/app/publish.js`, `commands/cloudflare/deploy-version.js`, `commands/cloudflare/release.js`, `test/unit-tests/lib/app-state.test.js` (removed), `test/unit-tests/lib/publishing/resolve-running-build.test.js`, `test/unit-tests/lib/release/deploy-cloudflare-version.test.js`, `test/unit-tests/lib/cloudflare/create-worker-version.test.js`, `test/unit-tests/commands/app/publish.test.js`, `test/unit-tests/commands/cloudflare/deploy-version.test.js`, `test/unit-tests/commands/cloudflare/release.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: Targeted publishing/release/deploy command suite passed 71 tests; full `node run-tests.js` passed 360 tests; `npm run lint` passed; stale application-state grep and `lib/cloudflare/` Publishing API import grep were clean; `git diff --check` passed. The nonexistent planned `test/unit-tests/lib/cloudflare/deploy-worker-version.test.js` was omitted.
- Blockers: None.


### Task APIV1-7: `app create-release`, `app assign-build`, `app rollback`, and a thinner `app publish`

**Status:** Complete
**Depends on:** APIV1-4, APIV1-5, APIV1-6
**Documentation:** `commands/README.md`; `docs/publish.md` is the model to rewrite from

**Objective**

An operator can create a Release without touching any build, assign an
existing Release to a build explicitly, roll a build back to an earlier
Release, or do the common create-and-assign case in one command — matching
the API's own decomposition instead of the old single `publish` verb.

**Scope**

- In: `commands/app/create-release.js`, `commands/app/assign-build.js`,
  `commands/app/rollback.js`; rewriting `commands/app/publish.js` as a thin
  composition of create-release + assign-build; updating
  `commands/app/index.js`'s `subcommands` map; `docs/publish.md` and new docs
  for the three new sub-commands.
- Out: `cloudflare release` (APIV1-8).

**Design and invariants**

- `app create-release`: `--environment/-e` (required, for origin/token
  resolution only — never resolves a build id), `--dry-run`, `--verbose`,
  `--origin`, `--token`, optional `--message`/`--source-revision` for
  provenance. A real run prints the release id and counts; `--dry-run` prints
  only the server-backed object diff and explicitly labels it as an
  unvalidated, no-write preview.
- `app assign-build`: `--environment/-e` (required), `--build-id` (required),
  `--release-id` (required), `--reason` (default `publish`). Resolves the
  current `ETag` itself; the operator never supplies a precondition header
  directly.
- `app rollback`: `--environment/-e` (required), `--build-id` (required), and
  either `--release-id` (assign that exact release) or `--list` to print
  recent Releases/activations for that build without assigning anything.
  Always assigns with `reason: 'rollback'`.
- `app publish`: unchanged flags where possible (`--environment/-e`,
  `--build-id`, `--dry-run`, `--verbose`, `--origin`, `--token`); drops
  `--bootstrap` (no longer meaningful, per APIV1-4). Internally: call
  create-release's library operation, then (unless `--dry-run`)
  assign-build's library operation against the resolved build id. Build id
  resolution is `--build-id`, then discovery's `runningBuildId` (APIV1-6).
  A server with no configured runtime build id produces a `UsageError` naming
  `--build-id` and `app assign-build` as explicit remedies.
- None of these commands print the bearer token, under any flag, in any
  path — unchanged invariant.
- Command modules stay wiring; any non-trivial logic belongs in the
  `lib/publishing/` operations from APIV1-4/APIV1-5.

**Expected touch points**

- `commands/app/index.js`
- `commands/app/create-release.js`
- `commands/app/assign-build.js`
- `commands/app/rollback.js`
- `commands/app/publish.js`
- `docs/publish.md`, `docs/create-release.md`, `docs/assign-build.md`,
  `docs/rollback.md`
- `test/unit-tests/commands/app/*.test.js`

**Acceptance criteria**

- [x] `node kixx.js app --help` lists all four sub-commands with correct
      descriptions.
- [x] `app create-release` never issues a `PUT /builds/:buildId` request under
      any flag combination.
- [x] `app create-release --dry-run` prints no release id and makes no write or
      Release-validation request.
- [x] `app assign-build` never re-uploads content or creates a Release; it
      only reads the current pointer and writes a new one.
- [x] `app rollback --list` prints Release/activation history and makes no
      write; `app rollback --release-id <id>` assigns with `reason: rollback`.
- [x] `app publish` produces the same operator-visible summary output shape as
      today (environment, origin, build id, resource counts, release id) minus
      bootstrap and application-state text.
- [x] `app publish` without `--build-id` uses discovery's `runningBuildId`,
      including when an obsolete application-state file remains in the
      checkout.
- [x] A missing `--environment`, origin, or token still produces a
      `UsageError` naming the file and key path, with no stack trace, for
      every one of the four commands.
- [x] Each new/changed command has a doc file covering its options,
      configuration, and failure modes.

**Validation**

- `node run-tests.js test/unit-tests/commands/app`
- `node kixx.js app --help`, and `--help` for each sub-command
- `npm run lint`

**Progress and handoff**

- Completed: Added create-release, assign-build, and rollback commands; rewrote publish as create-and-assign composition; registered all commands; added shared environment resolution, focused command tests, and operator documentation.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: Implicit build resolution precedes scanning and content creation so a null `runningBuildId` fails before writes. `create-release` uses the same environment resolver but never invokes build resolution or assignment. All commands share one resolver for consistent environment/origin/token failures. Dry-run output calls itself an unvalidated preview and omits the Release id. Rollback list mode requests the 25 most recent Releases and activations without assigning.
- Actual files changed: `lib/publishing/resolve-publishing-environment.js`, `lib/publishing/create-application-release.js`, `commands/app/index.js`, `commands/app/create-release.js`, `commands/app/assign-build.js`, `commands/app/rollback.js`, `commands/app/publish.js`, `docs/publish.md`, `docs/create-release.md`, `docs/assign-build.md`, `docs/rollback.md`, `test/unit-tests/commands/app/publish.test.js`, `test/unit-tests/commands/app/create-release.test.js`, `test/unit-tests/commands/app/assign-build.test.js`, `test/unit-tests/commands/app/rollback.test.js`, `test/unit-tests/commands/app/environment-errors.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: `node run-tests.js test/unit-tests/commands/app` passed 12 tests; app and all four subcommand help commands passed; `npm run lint` passed; full `node run-tests.js` passed 370 tests; stale app-command vocabulary grep and `git diff --check` passed.
- Blockers: None.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task APIV1-8: `cloudflare release` adopts the pre-staging workflow

**Status:** Complete
**Depends on:** APIV1-7, APIV1-6
**Documentation:** `tmp/publishing-api.md` (Workflow #2: Code-plus-content release); `docs/release.md` is the model to rewrite from

**Objective**

`kixx.js cloudflare release` ships code and content as one atomic unit using
the API's own pre-staging workflow. It first determines and freezes the exact
Worker artifact without uploading it, then stages and verifies content for
that artifact's build id before Cloudflare can create or deploy it. This
replaces today's create-version-then-publish ordering and the local-state
resumption logic that ordering required.

**Scope**

- In: Splitting Worker version preparation from its remote creation while
  preserving the existing idempotency and resource-resolution decisions;
  adding a `lib/release/` Cloudflare release coordinator; reducing
  `commands/cloudflare/release.js` to configuration, invocation, and output;
  making standalone `create-worker-version` an undeployed-only operation;
  removing the old local-state recovery branches; updating
  `docs/create-worker-version.md` and `docs/release.md`.
- Out: Changing how Worker inputs are hashed, how resources are provisioned,
  or how unprovisioned Durable Object namespaces force deployment. The
  standalone deployment guard is APIV1-6.

**Design and invariants**

- Preparation performs the current Worker fetch, resource resolution,
  environment/config loading, bundle, hash comparison, Durable Object
  analysis, and idempotency decision, but makes no Worker-version upload or
  deployment. When creation is needed it returns a frozen artifact containing
  the exact modules, bindings, exports, configuration, deployment requirement,
  and newly chosen `BUILD_ID` which the later create step must use unchanged.
- The prepared `BUILD_ID` identifies one release attempt, not merely one wall
  clock second. Preserve the timestamp's operator readability but add a
  collision-resistant generated component (with an injectable generator for
  tests), so concurrent preparations cannot silently give different Worker
  artifacts the same build coordinate.
- `resources-resolved` stops after preparation: no content scan, Release,
  build assignment, Worker-version upload, or deployment.
- `skipped` takes the content-only path: discover the server's
  `runningBuildId`, create a Release, and compare-and-swap that running build.
  It creates no future build pointer, Worker version, or deployment.
- A prepared version takes this order: (1) create the Release with
  `provenance.intendedForBuildId` set to the prepared build id; (2) use
  APIV1-5's first-assignment-only operation to assign it with
  `If-None-Match: *`; (3) `GET /builds/:buildId` and verify the staged release
  id; (4) upload the exact prepared Worker artifact; (5) deploy it explicitly
  if creation did not already force deployment.
- A collision on the prepared build id is a `412` and stops. The workflow
  never reads the existing pointer and changes it with `If-Match`; a timestamp
  collision or concurrent publisher cannot turn pre-staging into an overwrite.
- Preparation and remote creation are also used by the standalone
  `create-worker-version` operation so there remains one implementation of
  bundling, idempotency, version serialization, and state recording.
- Standalone `create-worker-version` drops `--deploy` and may commit only an
  artifact Cloudflare can keep undeployed. If preparation finds an
  unprovisioned Durable Object namespace which would force deployment, it
  stops before upload and directs the operator to `cloudflare release`. This
  prevents a lower-level command from bypassing the atomic workflow.
- The first-Worker/unprovisioned-Durable-Object case has no content window:
  the build pointer is verified before the prepared artifact is uploaded, so
  even a deployment forced during creation can serve content immediately.
- Failure before build assignment may leave uploaded content objects or an
  immutable Release, but changes no build and creates no Worker version.
  Failure after assignment but before Worker creation may additionally leave
  an inert future build pointer; report its build id so it is auditable through
  `GET /builds`. Neither case changes traffic, and a new run is safe.
- A deployment failure after successful staging and Worker creation leaves the
  build pointer correct and the version undeployed; recovery is
  `cloudflare deploy-version` for the reported version id.
- Output follows the real phases: Worker preparation, content publish/staging,
  Worker creation, then deployment. Omitted phases are reported explicitly so
  a failure or `skipped`/`resources-resolved` outcome is not misleading.

**Expected touch points**

- `commands/cloudflare/release.js`
- `commands/cloudflare/create-worker-version.js`
- `lib/release/cloudflare-release.js` (or similar)
- `lib/cloudflare/prepare-worker-version.js` (or an equivalent split of the
  current module)
- `lib/cloudflare/create-worker-version.js`
- `lib/cloudflare/build-id.js`
- `docs/release.md`
- `docs/create-worker-version.md`
- `test/unit-tests/commands/cloudflare/create-worker-version.test.js`
- `test/unit-tests/commands/cloudflare/release.test.js`
- `test/unit-tests/lib/release/cloudflare-release.test.js`
- `test/unit-tests/lib/cloudflare/prepare-worker-version.test.js`
- `test/unit-tests/lib/cloudflare/create-worker-version.test.js`
- `test/unit-tests/lib/cloudflare/build-id.test.js`

**Acceptance criteria**

- [x] Preparation distinguishes `resources-resolved`, `skipped`, and a frozen
      version artifact without uploading or deploying a Worker version.
- [x] The created Worker version is byte-for-byte derived from the prepared
      artifact and uses its exact `BUILD_ID`; source/config changes after
      preparation cannot alter the upload silently.
- [x] Independently prepared versions receive distinct build ids even when
      prepared during the same clock tick, while tests can inject deterministic
      ids.
- [x] A code change stages and verifies content for the prepared build id with
      first-assignment-only semantics before any Worker-version upload.
- [x] The forced-deploy path (unprovisioned Durable Object namespace) is
      exercised in a test and produces no window in which the deployed
      version's build id has no assigned Release.
- [x] Standalone `create-worker-version` has no `--deploy` option, refuses any
      creation Cloudflare would force-deploy, and directs the operator to
      `cloudflare release` before uploading the version.
- [x] A content-only change creates a Release and assigns it to the live
      build id discovered from the server, creates no future pointer or Worker
      version, deploys nothing, and says so.
- [x] `resources-resolved` stops before any Release or assignment.
- [x] A collision on the future build id stops without changing its existing
      pointer or creating a Worker version.
- [x] A failure before Worker creation reports any inert Release/build pointer
      it left, confirms that traffic was unchanged, and gives safe retry
      guidance.
- [x] A deployment failure after successful staging reports
      `cloudflare deploy-version` as the recovery, naming the version id.
- [x] No branch of this command reads `hasPublishedBuild`-style local state to
      decide correctness (APIV1-6's guard change applies transitively).
- [x] The command module contains only argument/configuration wiring, invoking
      the coordinator, and rendering its phase results.
- [x] `docs/release.md` documents the new phase order, both outcomes, and
      recovery per failure point, and no longer mentions `--bootstrap` or a
      first-release bootstrap window.

**Validation**

- `node run-tests.js test/unit-tests/commands/cloudflare/create-worker-version.test.js test/unit-tests/commands/cloudflare/release.test.js test/unit-tests/lib/release/cloudflare-release.test.js test/unit-tests/lib/cloudflare/build-id.test.js test/unit-tests/lib/cloudflare/prepare-worker-version.test.js test/unit-tests/lib/cloudflare/create-worker-version.test.js`
- `node kixx.js cloudflare create-worker-version --help`
- `node kixx.js cloudflare release --help`
- `npm run lint`
- A real release of `tmp/sample-app/` against a v1 Publishing API, if that
  sample app has been updated to the new contract by then — confirm with the
  user before assuming it's available.

**Progress and handoff**

- Completed: Split Worker preparation from upload, added collision-resistant build ids, implemented the pre-staging release coordinator and phase output, made standalone version creation undeployed-only, added recovery reporting, updated documentation, and added focused coverage for content-only, collision, forced-deploy, frozen-artifact, and phase-order behavior.
- Current state: Complete.
- Remaining: Nothing. The optional real `tmp/sample-app/` release was not run because the plan requires user confirmation before assuming that app serves Publishing API v1.
- Decisions and discoveries: Worker creation is split into preparation and
  commit. Preparation freezes the exact artifact and determines whether any
  version is needed before publishing begins; staging still precedes every
  possible Worker upload or forced deployment. Prepared build ids include a
  collision-resistant component rather than relying on clock resolution.
  Cross-system orchestration belongs in `lib/release/`, not the command module.
- Actual files changed: `lib/cloudflare/build-id.js`, `lib/cloudflare/create-worker-version.js`, `lib/cloudflare/prepare-worker-version.js`, `lib/release/cloudflare-release.js`, `commands/cloudflare/create-worker-version.js`, `commands/cloudflare/release.js`, `docs/create-worker-version.md`, `docs/release.md`, `test/unit-tests/lib/cloudflare/build-id.test.js`, `test/unit-tests/lib/cloudflare/create-worker-version.test.js`, `test/unit-tests/lib/cloudflare/prepare-worker-version.test.js`, `test/unit-tests/lib/release/cloudflare-release.test.js`, `test/unit-tests/commands/cloudflare/create-worker-version.test.js`, `test/unit-tests/commands/cloudflare/release.test.js`, `agents/plans/publishing-api-v1-migration.md`.
- Validation run: The exact targeted suite passed 56 tests; both command help checks passed and `create-worker-version` exposes no `--deploy`; stale state/bootstrap grep was clean; full `npm test` passed 379 tests; `git diff --check` passed. The optional real sample-app release was not run pending user confirmation.
- Blockers: None.


### Task APIV1-9: README and cross-command documentation pass

**Status:** Complete
**Depends on:** APIV1-7, APIV1-8
**Documentation:** None

**Objective**

`README.md`'s command listing and every doc under `docs/` describe the
commands that actually exist after this migration, with no dangling
references to closures, `--bootstrap`, application state, the old
single-`publish` model, or standalone Worker-version deployment.

**Scope**

- In: `README.md`'s workflow list; a final read-through of `docs/publish.md`,
  `docs/create-release.md`, `docs/assign-build.md`, `docs/rollback.md`,
  `docs/create-worker-version.md`, `docs/deploy-version.md`, and
  `docs/release.md` for internal consistency and cross-links.
- Out: Any further behavior change — this task is documentation-only.

**Design and invariants**

- Every command listed in `README.md` links to a doc file that exists and
  matches the command's actual current options.
- No doc references `--bootstrap`, closures, `commitClosure`, or
  `.kixx/app-state.*` after this task.
- `create-worker-version` is documented as undeployed-only and directs any
  deployment or forced-deployment workflow to `cloudflare release` or
  `cloudflare deploy-version`, as appropriate.

**Expected touch points**

- `README.md`
- `docs/*.md`

**Acceptance criteria**

- [x] Every `app`/`cloudflare` sub-command from `commands/*/index.js` appears
      in `README.md` with a working doc link.
- [x] A search for `bootstrap`, `closure`, `commitClosure`, and `app-state`
      across `docs/` and `README.md` returns nothing left over from the old
      model.
- [x] No `create-worker-version` documentation advertises `--deploy` or an
      automatic forced-deployment path.

**Validation**

- Manual read-through plus
  `rg -i 'closure|bootstrap|commitClosure|app-state' docs README.md` showing no
  stale references.

**Progress and handoff**

- Completed: Updated the workflow index, added missing create-worker guidance,
  and aligned deployment safety documentation with Publishing API build
  pointers.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: `docs/deploy-version.md` still described the
  deleted checkout-local application-state guard. It now documents the
  authoritative Publishing API pointer check and its `--force` bypass.
- Actual files changed: `README.md`, `docs/create-worker.md`,
  `docs/deploy-version.md`, `docs/release.md`,
  `agents/plans/publishing-api-v1-migration.md`.
- Validation run: Manual read-through of all eight command docs; command-index
  help checks passed; `rg -n -i 'closure|bootstrap|commitClosure|app-state'
  docs README.md` returned no matches; `git diff --check` passed.
- Blockers: None.
