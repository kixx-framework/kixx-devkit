# Implementation Plan: Publishing Assignment Protocol 2 and Content Format 4

## Implementation Approach

The Kixx framework merged
[PR #156](https://github.com/kixx-framework/kixx/pull/156), which changes the
Publishing API in two breaking ways. This devkit is the external publishing
client named in the framework's `docs/build-assignment-rollout.md`, so it
cannot write to an upgraded server until it implements both changes.

**Assignment protocol 2.** The build pointer precondition moved out of HTTP
validators and into the request body. `PUT /builds/:buildId` now requires
`data.attributes.expectedAssignmentId`: an opaque server-generated version-4
UUID copied verbatim from the Build resource, or explicit `null` for a build
that has never been assigned. `If-Match` and `If-None-Match` are rejected with
`400`. Omitting the field is `428 PreconditionRequired`. Discovery advertises
`buildAssignmentProtocolVersion: 2`; its absence identifies a legacy server.

**Content format 4.** `addressingFormat` is now `4`. The hashing algorithm did
not change — format 4 is a storage-namespace reset for the new assignment
schema — so object ids this tool computes stay byte-identical. `publish-content.js`
asserts `addressingFormat === FORMAT`, so every publish fails against an
upgraded server until the constant moves. Inline manifest content was removed
from the API entirely, along with the `maxInlineContentBytes` limit.

The upgraded client targets **protocol 2 and format 4 only**. There is no
legacy write path and no runtime branch on protocol version: a server that does
not advertise protocol 2 is refused before any write, the same way an
unsupported addressing format is refused today. Supporting both generations was
considered and rejected — it doubles the write path and its tests to serve a
maintenance window that the rollout guide already describes as a planned
outage.

Cross-cutting concerns:

- **The assignment identity is opaque.** Treat `assignmentId` as a string
  copied verbatim from Build JSON. Never derive it from a release id, a root
  hash, a response header, or any local computation. No code outside the
  transport may parse or validate its shape.
- **No idempotent retry exists for pointer writes.** Protocol 2 removed the
  "assigning the current Release is a safe no-op" property that made a blind
  retry safe: the no-op happens only *after* the precondition passes, and
  A→B→A produces three distinct identities. The client must therefore not
  retry `PUT /builds/:buildId` at the transport layer. A lost response is an
  operator-visible reconcile, not a silent re-send.
- **A conflict is never resolved automatically.** On `412 BuildPointerConflict`
  the tool re-reads the build for diagnostics only, reports the observed
  pointer beside the intended one, and exits non-zero. It never writes again.
  Auto-reconciling a 412 by checking "the pointer already holds my release"
  would silently overwrite a concurrent publisher's intent in exactly the case
  the precondition exists to catch.
- **Capability negotiation happens before the first write of any kind.**
  Content contract version, addressing format, and assignment protocol version
  are checked together, from one discovery response, by one shared module.
- **One discovery round trip per process.** `PublishingAPIClient#discover()`
  memoizes its result. Discovery describes immutable properties of the running
  deploy, and negotiation now happens on paths that previously did not
  discover at all (`app assign-build`, `app rollback`). Memoizing keeps those
  paths at one extra request instead of threading a capabilities object
  through every call site.
- **Activation history is informational.** It is best-effort upstream and may
  have permanent gaps. Nothing in this tool may treat a missing entry as an
  error or as evidence that an assignment did not happen. The build pointer is
  authoritative.

### Task summary

| ID | Outcome | Depends on |
| --- | --- | --- |
| P2-1 | Format 4 constant and shared capability negotiation | None |
| P2-2 | Transport: JSON precondition, no pointer-write retries | None |
| P2-3 | Assignment orchestration on assignment identities | P2-1, P2-2 |
| P2-4 | Command and release-pipeline surfaces | P2-3 |
| P2-5 | Documentation | P2-1 … P2-4 |

---

### Task P2-1: Negotiate format 4 and protocol 2 from one discovery response

**Status:** Not started
**Depends on:** None
**Documentation:** `docs/kixx-publishing-api.md` "Discovery"; `tmp/build-assignment-rollout.md` "Client handoff"

**Objective**

The tool recognizes an upgraded server and refuses an un-upgraded one before
writing anything. Object ids it computes match a format-4 server, and every
command that writes — content or pointer — validates the same three capability
values through one module.

**Scope**

- In: `FORMAT` constant, a new capability-negotiation module, memoized
  discovery on the client, replacement of the inline compatibility assertions
  in `publish-content.js`.
- Out: the pointer write itself (P2-2), the assignment read/write sequence
  (P2-3).

**Design and invariants**

- `FORMAT` becomes `4`. The digest domains, `DIGEST_BYTES`, base32 alphabet,
  and `canonicalize()` output are unchanged — this was verified against
  `tmp/sample-app/kixx/content-addressable-store/addressing.js`, which is
  format 4 and still hashes blobs as `sha256(0x00 || bytes)` truncated to 16
  bytes. Existing fixed hash vectors in the addressing tests must keep passing
  unedited; only the `FORMAT` assertion changes. If any vector needs editing,
  stop — that means the wire format really did change and this plan is wrong.
- The negotiation module exports one function that takes the discovery
  attributes and throws a single operator-facing error naming the server value
  and the supported value. It checks `contentContractVersion`,
  `addressingFormat`, and `buildAssignmentProtocolVersion`.
- An absent `buildAssignmentProtocolVersion` is reported as a legacy server,
  not as a malformed response, and the message must tell the operator the
  deployment needs the framework upgrade.
- `publish-content.js` keeps its manifest-entry-count check, which is a
  per-release limit rather than a capability, and delegates the three version
  checks to the shared module.
- `discover()` memoizes on the client instance. Concurrent callers must share
  one in-flight request rather than issuing two.

**Expected touch points**

- `lib/publishing/addressing.js` — `FORMAT = 4`, format history note in the
  module comment
- `lib/publishing/negotiate-capabilities.js` — new shared negotiation
- `lib/publishing/publishing-api-client.js` — memoized `discover()`
- `lib/publishing/publish-content.js` — delegate version checks
- `lib/publishing/content-layout.js` — module comment references `FORMAT = 3`
- `test/unit-tests/lib/publishing/addressing.test.js`
- `test/unit-tests/lib/publishing/publish-content.test.js`
- `test/unit-tests/lib/publishing/negotiate-capabilities.test.js` — new

**Acceptance criteria**

- [ ] `FORMAT` is `4` and every existing fixed hash vector still passes.
- [ ] Negotiation rejects a mismatched contract version, a mismatched
      addressing format, and a missing or non-`2` protocol version, each with
      a distinct message naming both values.
- [ ] Negotiation accepts a discovery response carrying contract 1, format 4,
      protocol 2, and ignores unknown extra attributes.
- [ ] `discover()` issues one HTTP request when called repeatedly, including
      concurrently.
- [ ] `publish-content.js` fails on an incompatible server during its
      discovery phase, with the phase reported as before.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing` — negotiation and
  addressing behavior
- `npm run lint`
- Unit coverage for each rejection branch and for discovery memoization.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task P2-2: Send the JSON assignment precondition and stop retrying pointer writes

**Status:** Not started
**Depends on:** None
**Documentation:** `docs/kixx-publishing-api.md` "Assign a Release to a build"

**Objective**

`PublishingAPIClient` speaks protocol 2 on the wire: the precondition travels
in `data.attributes.expectedAssignmentId`, no conditional request headers are
sent, and a pointer write is attempted exactly once so a lost response can
never become a confusing `412`.

**Scope**

- In: `assignBuild()` signature and request construction, removal of the
  conditional headers, retry exemption for `PUT /builds/:buildId`, removal of
  the dead inline-content guard.
- Out: deciding *which* identity to send (P2-3), operator output (P2-4).

**Design and invariants**

- `assignBuild(buildId, releaseId, options)` takes one required
  `expectedAssignmentId` that is either a non-empty string or `null`. The
  paired `expectedReleaseId` / `expectUnassigned` options are removed rather
  than deprecated; leaving them would let a caller express a precondition the
  protocol no longer has. Omitting the option entirely is a programming error
  and asserts locally instead of provoking a server `428`.
- The client does not validate the UUID shape. The server owns that
  vocabulary, returns `422 InvalidBuildAssignment` for a malformed token, and
  the existing `InvalidBuildAssignmentError` already carries it.
- No `if-match` or `if-none-match` header is ever set on any request.
- The retry exemption is expressed as a per-request option on the private
  `#request()` path, not as a URL pattern match, so the exemption is stated at
  the one call site that needs it and future write endpoints must opt out
  deliberately. A non-retried network failure still raises
  `PublishingApiError` with `status: null` and `attempts: 1`.
- `validateRelease()` drops `hasInlineContent()` and the helper is deleted;
  inline content no longer exists anywhere in the API.
- The returned build record already spreads response attributes, so
  `assignmentId` flows to callers with no mapping change. Confirm rather than
  assume.

**Expected touch points**

- `lib/publishing/publishing-api-client.js` — `assignBuild()`, `#request()`,
  `validateRelease()`
- `test/unit-tests/lib/publishing/publishing-api-client.test.js`

**Acceptance criteria**

- [ ] A build assignment sends `expectedAssignmentId` in the JSON body with
      `data.type`, `data.id`, `releaseId`, and `reason`, and sends no
      conditional header.
- [ ] `expectedAssignmentId: null` is serialized as JSON `null`, not omitted.
- [ ] A missing `expectedAssignmentId` option fails locally before any fetch.
- [ ] A network failure on a pointer write raises after one attempt; an
      object upload or release creation still retries as before.
- [ ] A `429` or `5xx` on a pointer write is not retried.
- [ ] `428`, `422`, and `412` responses still map to
      `PreconditionRequiredError`, `InvalidBuildAssignmentError`, and
      `BuildPointerConflictError`.
- [ ] The returned record exposes `buildId`, `releaseId`, `assignedAt`, and
      `assignmentId`.
- [ ] No inline-content guard or `maxInlineContentBytes` fixture remains.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/publishing-api-client.test.js`
- `npm run lint`
- Fetch-mock assertions on the exact request body and on attempt counts per
  endpoint.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task P2-3: Assign releases using observed assignment identities

**Status:** Not started
**Depends on:** P2-1, P2-2
**Documentation:** `docs/kixx-publishing-api.md` workflows 1–4 and "Bootstrap"

**Objective**

Every assignment this tool performs — publish, pre-stage, rollback, explicit
assign — reads the build, quotes the identity it observed, and stops with an
actionable report when the pointer moved underneath it.

**Scope**

- In: `lib/publishing/assign-release.js` (both exported functions), protocol
  negotiation before the write, conflict diagnostics.
- Out: how commands print the result (P2-4).

**Design and invariants**

- `assignRelease()` reads `GET /builds/:buildId` and sends the returned
  `assignmentId`. `BuildNotFoundError` means never assigned and becomes
  `expectedAssignmentId: null`. Any other read failure propagates unchanged.
- `assignReleaseToNewBuild()` always sends `null` and never reads first. This
  is the pre-staging and bootstrap path, and reading first would introduce a
  window in which a concurrent publisher's first assignment is overwritten.
- Both call the P2-1 negotiation before writing. Negotiation failure must be
  distinguishable from an assignment failure so `app publish` does not report
  a created Release as stranded when nothing was ever attempted.
- On `BuildPointerConflictError`, re-read the build once for diagnostics. The
  re-read is best-effort: if it also fails, report the conflict without the
  observed state rather than masking the original error. The raised error
  keeps `BuildPointerConflictError` as its type, carries the intended release
  id, the intended precondition, and the observed `releaseId` and
  `assignmentId`, and its message states that no retry was attempted and that
  the operator must reconcile before acting.
- The conflict error message must not suggest re-running the same command,
  because that would re-read and then happily overwrite the concurrent change.
- A successful no-op — the build already points at the target Release and the
  precondition passed — is a success. It returns the preserved `assignedAt`
  and `assignmentId` and records no Activation upstream; callers must not
  treat the absent history entry as a failure.

**Expected touch points**

- `lib/publishing/assign-release.js`
- `test/unit-tests/lib/publishing/assign-release.test.js`

**Acceptance criteria**

- [ ] An assignment to an existing build quotes the `assignmentId` from the
      immediately preceding read, never a release id.
- [ ] A `404 BuildNotFound` on the read produces `expectedAssignmentId: null`.
- [ ] `assignReleaseToNewBuild()` performs no read and always sends `null`.
- [ ] An incompatible server fails before the build read, with a negotiation
      error rather than an assignment error.
- [ ] A `412` produces a `BuildPointerConflictError` carrying intended and
      observed pointer state, and no second write occurs.
- [ ] A `412` whose diagnostic re-read also fails still reports the conflict.
- [ ] A same-release assignment that passes its precondition succeeds and
      returns the preserved assignment identity.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/assign-release.test.js`
- `npm run lint`
- Spy assertions proving exactly one write call on the conflict path.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task P2-4: Surface assignment identities in commands and the release pipeline

**Status:** Not started
**Depends on:** P2-3
**Documentation:** `docs/kixx-publishing-api.md` "Build activation history"

**Objective**

An operator can correlate what a command did with the server's build pointer
and activation history, and the Cloudflare pre-staging check verifies the
pointer it staged rather than only the Release it names.

**Scope**

- In: output of `app assign-build`, `app publish`, and `app rollback`;
  `renderHistory()` in the rollback command; the staged-pointer verification
  in `lib/release/cloudflare-release.js`; the `ReleaseAssignmentError`
  recovery hint.
- Out: new commands, new options, activation-history repair.

**Design and invariants**

- `assign-build`, `publish`, and `rollback` print the resulting
  `assignmentId` alongside the build id and release id. It is the only value
  that ties a command's output to an activation-history entry.
- `renderHistory()` currently prints `entry.releaseId`, an attribute the API
  has never returned, so list mode prints blank lines today. Activation
  attributes are `buildId`, `assignmentId`, `fromReleaseId`, `toReleaseId`,
  `activatedAt`, `activatedBy`, and `reason`. Render the transition
  (`fromReleaseId` → `toReleaseId`), the timestamp, the reason, and the
  assignment id. A `null` `fromReleaseId` is a first assignment, not missing
  data.
- An empty activation list is a legitimate state — best-effort history, a
  no-op assignment, or a build assigned exactly once with a lost append. Print
  an explanatory line, never an error.
- The `--release-id` value an operator picks from list mode must remain
  copy-pasteable into `--release-id`; keep ids unabbreviated.
- Cloudflare pre-staging compares both `releaseId` and `assignmentId` from the
  read-back against the assignment response before creating the Worker
  version. A mismatch in either is the existing hard stop, with the message
  naming both expected and observed values.
- The `ReleaseAssignmentError` recovery hint still prints a runnable
  `app assign-build` command. It must not print a precondition token —
  `assign-build` observes the identity itself at run time, and a stale token
  in a copy-pasted command would be a fresh failure mode.

**Expected touch points**

- `commands/app/assign-build.js` — output block
- `commands/app/publish.js` — output block and `renderPublishResult()`
- `commands/app/rollback.js` — output block and `renderHistory()`
- `lib/release/cloudflare-release.js` — staged pointer verification
- `test/unit-tests/commands/app/assign-build.test.js`
- `test/unit-tests/commands/app/publish.test.js`
- `test/unit-tests/commands/app/rollback.test.js`
- `test/unit-tests/lib/release/cloudflare-release.test.js`

**Acceptance criteria**

- [ ] Each of the three commands prints the resulting assignment id.
- [ ] `rollback --list` renders real activation attributes, including a first
      assignment with a `null` `fromReleaseId`.
- [ ] `rollback --list` with no activations prints an explanation and exits 0.
- [ ] Pre-staging fails when the read-back `assignmentId` differs from the
      assignment response, with both values in the message, and no Worker
      version is created.
- [ ] A stranded-Release error still prints a runnable recovery command with
      no precondition token in it.

**Validation**

- `node run-tests.js test/unit-tests/commands/app test/unit-tests/lib/release`
- `npm run lint`
- Output assertions on rendered text for the first-assignment and
  empty-history cases.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task P2-5: Document protocol 2 behavior and the server requirement

**Status:** Not started
**Depends on:** P2-1, P2-2, P2-3, P2-4

**Objective**

The devkit's own documentation describes the protocol the tool actually
speaks, states the minimum server it works against, and tells an operator what
to do after a conflict instead of implying a retry is safe.

**Scope**

- In: `docs/app.md` assignment, publish, and rollback sections; a short
  compatibility statement; `docs/cloudflare.md` release failure table where it
  describes pointer state.
- Out: `docs/kixx-publishing-api.md`, which is a vendored copy of the
  framework's reference and is already current.

**Design and invariants**

- Remove every mention of `If-None-Match: *` and of a release id used as a
  compare-and-swap precondition. Describe the precondition as the observed
  assignment identity, read immediately before the write.
- State plainly that this devkit requires a server advertising assignment
  protocol 2 and addressing format 4, and that it refuses older deployments
  before writing.
- Describe conflict behavior as: stop, report the observed pointer, reconcile
  manually. Do not describe any retry as safe.
- Note that activation history is best-effort and may have gaps, so an absent
  entry never means an assignment failed.

**Expected touch points**

- `docs/app.md`
- `docs/cloudflare.md`
- `README.md` if a compatibility line belongs there

**Acceptance criteria**

- [ ] No documentation describes conditional headers or release-id
      preconditions.
- [ ] The server requirement is stated once, where a reader looks for it.
- [ ] Conflict and best-effort-history behavior are documented.
- [ ] Documented command output matches what the commands print after P2-4.

**Validation**

- `npm test` — linter and full suite
- Read each changed section against the implemented behavior.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

## Out of scope

- **Dual protocol support.** Decided against; see the approach section.
- **Automatic 412 reconciliation.** Decided against; the precondition exists to
  surface concurrent writes.
- **Activation-history repair.** The gap is upstream, best-effort by design,
  and has no server endpoint to repair through.
- **Cutover tooling.** The rollout guide's snapshot and `DELETE FROM documents`
  steps are operator actions against a framework deployment, not devkit
  commands. Note if repeated cutovers make a snapshot command worth having.
- **Re-verifying object hashes.** Format 4 did not change the digest, so
  content already stored under format 3 hashes to the same ids. It is not
  reachable, because format 4 is a separate namespace, and republishing
  re-uploads it under the same ids.
