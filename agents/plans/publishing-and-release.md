Publishing and Release Implementation Plan
==========================================

Add content publishing to the devkit, and a release command that couples a
Cloudflare Worker version to the content it serves.

`kixx.js cloudflare create-worker-version` already builds and uploads the
application code. Nothing yet publishes the other half of a Kixx application:
`pages/`, `public/`, `static-assets/`, `templates/`, and `emails/`.


Implementation Approach
-----------------------

### The constraint everything else follows from

A Kixx application resolves its content through `BUILD_ID`. At runtime
`ContentAddressableStore#openSnapshot()` reads `context.runtime.build.id` and
asks the content store for the closure assigned to that build. `BUILD_ID` is a
plain-text Worker binding minted by `create-worker-version`.

If a version is deployed before content is published for its `BUILD_ID`, the
store throws `No registered content index for BUILD_ID <id>` and **every request
fails**. Publishing must precede deployment. That single fact produces the
three-phase release: create the version without deploying, publish content under
its build id, then deploy.

The reverse ordering has no escape hatch either: an undeployed version serves no
traffic, so there is no Publishing API to publish to before the first
deployment. See task PUB-5's `--bootstrap` handling.

### Build ids are mutable pointers, closures are immutable

The Durable Object holds `closure_entries` keyed by `root_hash` and a `builds`
table mapping `build_id -> root_hash`, upserted by `assignBuild()`. Closures are
never rewritten and blobs are never deleted. Consequences relied on throughout:

- Republishing a tree under an existing build id is how a content-only update
  reaches production. The closure commits first, then the pointer moves.
- The closure root hash is deterministic for a tree, so re-publishing an older
  source revision restores exactly the previous closure.
- A Worker version's content is therefore not frozen at deploy time. Deploying
  an older version restores old *code*; the content it serves is whatever its
  build id points at now.

### Two commands, two costs

`kixx.js app publish` republishes onto the build the environment already serves.
No Worker version, no deployment. This is the common path for content edits.

`kixx.js cloudflare release` runs the whole three-phase release. When
`create-worker-version` reports `skipped` because no code input changed, release
degrades to exactly what `app publish` does and says so.

### Ownership

- `lib/publishing/` is deployment-target-neutral. It knows HTTP, the Publishing
  API, the content conventions, and content addressing. It knows nothing about
  Cloudflare.
- `lib/app-state.js` is target-neutral durable state: which build an environment
  serves, and which builds have had content published.
- `lib/cloudflare/` keeps owning Cloudflare. `commands/cloudflare/release.js` is
  the only place the two are composed.
- Command modules stay wiring, per `commands/README.md`.

### Nothing is live until the closure commits

Blob uploads are content-addressed, idempotent, and completely inert until a
closure references them. An aborted publish leaves the site untouched and leaves
no garbage that a later run trips over. Every failure path in this plan relies on
that: abort before the closure, report, exit non-zero.

### Local validation precedes all network I/O

The entire source tree is scanned, mapped, and validated before a single request
is made. Every problem is collected and reported together, matching the
`err.push(...)` accumulating idiom the framework's own validators use.

### The stat diff, and why the ported hashing is safe

Hashes and sizes are computed locally, then compared against
`GET /publishing-api/v1/index/...` for each resource. Only 404s and mismatches
upload. The closure always names the complete client-side tree, because
`PUT /index/closure` replaces rather than merges.

This is sound even though the addressing is a port. An upload is skipped only
when the server itself just reported that exact hash published at that pathname.
A wrong local hash can therefore never produce a closure with dangling
references — it can only cause a redundant upload. `commitChanges()` does not
verify blob existence, so this property is the thing protecting the deploy.

### Publishing API contract

Base path `/publishing-api/v1`. Bearer token in `Authorization`. Successful
responses are `application/vnd.api+json`.

Stat, returning `200` with `data.attributes = { pathname?, hash, size, metadata }`
or `404`:

```text
GET /index/static-asset/*path
GET /index/global-template-partials
GET /index/base-templates
GET /index/page-metadata{/*path}
GET /index/page-partials{/*path}
GET /index/page-includes{/*path}
GET /index/page-templates/*path
GET /index/emails/*path
```

Upload, returning `201` with `data.attributes = { pathname?, hash, size }`:

```text
PUT /resources/static-asset/*path         raw bytes, any media type, non-empty
PUT /resources/global-template-partials   {data:{type,attributes:{bundle:[{id,source}]}}}
PUT /resources/base-templates             same shape, type BaseTemplates
PUT /resources/page-metadata{/*path}      {data:{type:'PageMetadata',attributes:<metadata>}}
PUT /resources/page-partials{/*path}      bundle:[{id,source}], type PagePartials
PUT /resources/page-includes{/*path}      bundle:{name:string}, type PageIncludes
PUT /resources/page-templates/*path       Content-Type: text/plain, raw source
PUT /resources/emails/*path               type EmailAssets
PUT /index/closure                        type ContentTree
```

The content tree, returning `201` with `{ buildId, hash, nodeCount }`:

```json
{
    "data": {
        "type": "ContentTree",
        "attributes": {
            "buildId": "2026-08-31T14-02-11Z",
            "staticAssets": { "stylesheets/site.css": { "hash": "...", "size": 1234 } },
            "globalTemplatePartials": { "hash": "...", "size": 98 },
            "baseTemplates": { "hash": "...", "size": 210 },
            "pages": {
                "about": {
                    "metadata": { "hash": "...", "size": 41 },
                    "partials": { "hash": "...", "size": 62 },
                    "includes": { "hash": "...", "size": 19 },
                    "template": { "pathname": "about/page.html", "hash": "...", "size": 28 }
                }
            },
            "emails": { "welcome": { "hash": "...", "size": 300 } }
        }
    }
}
```

Errors are JSON:API error documents with string `status` values, and a
validation failure may carry several error objects.

### Configuration

```text
.kixx/config.json    app.environments.<environment>.origin
.kixx/secrets.json   app.environments.<environment>.publishingToken
```

Neither can be declared in a command's static `requiredConfig` or
`requiredSecrets`, because the runner validates those before parsing
`--environment`. Validate inside the library, as
`commands/cloudflare/create-worker-version.js` already documents for
`requiredCloudflareConfig`.

### Testing

`test/unit-tests/` mirrors the source tree; see `test/README.md`. Run with
`node run-tests.js` and lint with `npm run lint`.

A sample Kixx application is available at `tmp/sample-app/` (git-ignored, not
part of this repository). `node-config.js` there sets `developerMode: true` only
in `development`; `staging` and `production` use the writable filesystem content
store. `node node-server.js -e staging` therefore serves a fully functional
Publishing API on `localhost:2026` for end-to-end verification with no
Cloudflare account.


Tasks
-----

### Task PUB-1: Content addressing and pathname rules ported into the devkit

**Status:** Not started
**Depends on:** None
**Documentation:** `tmp/sample-app/kixx/content-addressable-store/addressing.js`, `tmp/sample-app/kixx/content-addressable-store/content-layout.js`

**Objective**

The devkit can compute, for any content payload, the exact content address and
byte size the Kixx framework would compute for it, and can decide whether a
logical pathname is one the framework will accept. Every later task depends on
these two answers being identical to the server's.

**Scope**

- In: A port of `canonicalize()`, the domain-separated digest, and the base32
  encoding; a port of `isValidPathname()`, `normalizePathname()`,
  `RESERVED_PAGE_FILENAMES`, and `isValidTemplateFilepath()`; a byte-size helper.
- Out: Storage path builders (`getStaticAssetPath()` and friends) — the
  Publishing API takes logical pathnames, so the devkit never composes a storage
  pathname. Tree, set, and string digests — only blob digests are needed. Any
  network code (PUB-4).

**Design and invariants**

- `FORMAT = 2` is pinned as a documented constant. It namespaces server storage
  keys and the closure root hash, neither of which the devkit computes, so it is
  a documentation anchor rather than a digest input. A change to `FORMAT`
  upstream means this port must be re-verified.
- `lib/canonical-hash.js` must **not** be reused. It differs in ways that change
  the digest: it passes `Date` through to `JSON.stringify` where the framework
  serializes it as `{}`, and it does not reject non-finite numbers.
- Digest: `SHA-256` over a single domain byte followed by the payload bytes,
  truncated to the first 16 bytes, encoded as lowercase unpadded base32 with the
  alphabet `abcdefghijklmnopqrstuvwxyz234567`. Domain `0x00` for ArrayBuffer
  blobs, `0x01` for string blobs.
- `node:crypto`'s `createHash('sha256')` produces the same bytes as the
  framework's `crypto.subtle.digest`; a synchronous API is preferred here.
- Size is the UTF-8 byte length for string blobs and `byteLength` for binary,
  matching what `ContentStore#putFile()` returns.
- Mirror the upstream files closely enough that a future `diff` against them is
  readable. Note the upstream path in the module comment.

**Expected touch points**

- `lib/publishing/addressing.js` — canonicalize, blob digests, size helper
- `lib/publishing/content-layout.js` — pathname validity and normalization
- `test/unit-tests/lib/publishing/addressing.test.js`
- `test/unit-tests/lib/publishing/content-layout.test.js`

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `canonicalize()` sorts object keys, omits `undefined` properties, rejects
      non-finite numbers and unsupported types, and serializes a `Date` as `{}`.
- [ ] String and ArrayBuffer blob digests match the framework's for a fixed set
      of vectors covering: empty string, ASCII, multi-byte UTF-8, nested objects
      with unsorted keys, arrays, and binary bytes.
- [ ] `isValidPathname()` rejects uppercase, `..`, `//`, dot-prefixed segments,
      and characters outside `[a-z0-9_.-]`.
- [ ] The module comment names the upstream file, the pinned `FORMAT`, and the
      procedure for regenerating the test vectors.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing` — the ported behavior.
- Test vectors are hard-coded, because `tmp/` is git-ignored and cannot be
  imported from a test. Regenerate them by running the upstream
  `addressing.js` in Node against the same inputs and record the procedure in
  the test file.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-2: Content source scanner

**Status:** Not started
**Depends on:** PUB-1
**Documentation:** `tmp/sample-app/plugins/node-content-store/lib/developer-source-scanner.js` is the normative definition of these conventions

**Objective**

A project directory is turned into a complete, in-memory description of every
resource that should exist in a published build: its logical pathname, its
resource type, and the exact payload that would be uploaded. Problems found
while mapping are recorded rather than thrown, so PUB-3 can report all of them
at once.

**Scope**

- In: Walking `pages/`, `templates/`, `static-assets/`, `public/`, and `emails/`;
  applying the conventions; comment-stripping `.js` and `.css`; computing each
  resource's hash and size; collecting unmatched files and problems. Whatever
  `lib/file-system.js` must grow to support this.
- Out: Error message formatting and the decision to abort (PUB-3). Network
  access (PUB-4). Deciding what to upload (PUB-5).

**Design and invariants**

The conventions, mirroring `DeveloperSourceScanner`:

- `pages/**/page.json` marks a page. Its directory relative to `pages/` is the
  logical page pathname; `pages/page.json` is the root page `/`.
- The whole parsed `page.json` object is the `PageMetadata` payload.
- `page.json.template` names a sibling file. The published template pathname is
  the page pathname plus that filename. `"template": ""` means the page has no
  template — `DeveloperSourceScanner` tests `if (template)`, so empty string and
  absent behave identically. The filename must not collide with
  `RESERVED_PAGE_FILENAMES`.
- `page.json.partials` is an array of `{ id, filename }`, sorted by `id`, mapped
  to a `PagePartials` bundle of `{ id, source }`.
- `page.json.includes` is an object of `name -> { filename }`, keys sorted,
  mapped to a `PageIncludes` bundle of `name -> source`.
- Partials and includes bundles are published for every page even when empty,
  matching the scanner. Content addressing collapses every empty bundle to one
  shared blob, so this is nearly free and keeps development and production
  behavior identical.
- `templates/partials/**` becomes the `GlobalTemplatePartials` bundle, with `id`
  the path relative to that directory. `templates/base/**` becomes
  `BaseTemplates` the same way. Files directly under `templates/` are in neither.
- `static-assets/**` and `public/**` both map to static assets rooted at `/`:
  `static-assets/stylesheets/site.css` and `public/favicon.ico` become
  `stylesheets/site.css` and `favicon.ico`. A pathname produced by both trees is
  a recorded problem, never silently resolved.
- `emails/**/email.json` becomes an `EmailAssets` bundle. `htmlTemplate` and
  `textTemplate` are `{ id, filename }` naming sibling files and publish as
  `{ id, source }`; `partials` is an array of the same sorted by `id`;
  `contextData` passes through. `putEmailAssets` does not validate `contextData`,
  but `HyperviewService` reads `bundle.json.contextData`, so it must be sent.
- Comment stripping applies to `.js` and `.css` under `static-assets/` only, and
  removes the comment outright rather than blanking it — a browser asset has no
  stack-trace constraint. Everything under `public/`, and all HTML in `pages/`
  and `templates/`, is published byte-for-byte. A `.js` file that fails to parse
  is a recorded problem naming the file and line, never a silent verbatim
  fallback.
- Deterministic ordering everywhere: directory entries and bundle members sort
  by the same string comparison the framework uses, so two runs over an
  unchanged tree produce identical payloads.

**Expected touch points**

- `lib/publishing/scan-content-sources.js` — the walk and the conventions
- `lib/publishing/strip-asset-comments.js` — `.js` via the vendored acorn, `.css`
  via a small state machine that respects strings and `url()`
- `lib/file-system.js` — add directory reads, stat, and binary file reads
- `test/unit-tests/lib/publishing/scan-content-sources.test.js`
- `test/unit-tests/lib/publishing/strip-asset-comments.test.js`
- `test/unit-tests/lib/file-system.test.js`

**Acceptance criteria**

- [ ] Every convention above is covered by a test over a fixture tree.
- [ ] Each returned resource carries its type, logical pathname, payload, hash,
      and size.
- [ ] Files matching no convention are returned as `unmatchedFiles`, not
      dropped and not treated as errors.
- [ ] Problems are returned as data: missing referenced file, empty static
      asset, invalid pathname, reserved template filename, static asset pathname
      collision, malformed `page.json` or `email.json`, unparsable `.js`.
- [ ] Comment stripping leaves CSS strings and `url()` contents untouched, and
      leaves a JS hashbang, string, and regex literal untouched.
- [ ] Scanning the sample app at `tmp/sample-app/` yields no problems.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing test/unit-tests/lib/file-system.test.js`
- Scan `tmp/sample-app/` and confirm the resource count and that
  `templates/README.md` is the only unmatched file.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-3: Validation report

**Status:** Not started
**Depends on:** PUB-2
**Documentation:** None

**Objective**

An operator with a broken content tree sees every problem in one message,
phrased so the fix is obvious, and learns which files were not published. This
task owns the operator-facing text; PUB-2 owns finding the facts.

**Scope**

- In: Turning the scanner's problems into a single `UsageError`; formatting the
  unmatched-files report; the wording of both.
- Out: Detecting the problems (PUB-2). Anything about the network.

**Design and invariants**

- All problems are reported together. The message ends by stating that nothing
  was published, so an operator never has to wonder whether a partial write
  happened.
- Each line names the source file relative to the project directory and what is
  wrong with it, not an internal identifier.
- Unmatched files are reported as information, never as an error. A README in
  `templates/` must not block a deploy, but a mistyped include filename that
  resolves to nothing must be visible.
- `UsageError` prints its message with no stack trace, which is the correct
  presentation for something the operator fixes by editing files.

**Expected touch points**

- `lib/publishing/content-source-report.js`
- `test/unit-tests/lib/publishing/content-source-report.test.js`

**Acceptance criteria**

- [ ] A tree with several distinct problems produces one `UsageError` listing
      all of them.
- [ ] The message states that nothing was published.
- [ ] Unmatched files render as their own section and never raise.
- [ ] Paths are project-relative.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/content-source-report.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-4: Publishing API client

**Status:** Not started
**Depends on:** None
**Documentation:** The Publishing API contract in the Implementation Approach above

**Objective**

Every Publishing API interaction the devkit needs is available as a typed
method that either returns a parsed result or raises an error an operator can
act on. Transient failures are retried; failures that will not improve are not.

**Scope**

- In: Stat, upload, and closure-commit methods; bearer authentication; JSON:API
  envelope construction and parsing; JSON:API error document rendering; the
  retry policy.
- Out: Concurrency and the order requests are made in (PUB-5). Deciding what to
  upload (PUB-5).

**Design and invariants**

- Constructed with an origin and a token. One instance per publish.
- Retry network errors, `429`, and `5xx` up to three attempts with jittered
  exponential backoff — the policy shape of
  `ContentStore#callDurableObject()` in the sample app. Every other `4xx` fails
  immediately; it signals a content or credential bug that retrying cannot fix.
- A JSON:API error document is rendered into the message with each error's
  `status`, `code`, `detail`, and `source`, because a validation failure may
  carry several and each names a different field.
- `401` and `403` produce a message naming `.kixx/secrets.json` and the
  `app.environments.<environment>.publishingToken` key path, mirroring how the
  Cloudflare auth guidance turns an auth failure into instructions.
- Stat distinguishes "published, here is the reference" from "not published"
  (`404`) as ordinary results. Only genuine failures raise.
- The token must never appear in an error message, log line, or thrown error.
- `PUT /resources/page-templates/*path` sends `text/plain`; static assets send
  raw bytes with no required media type; everything else sends
  `application/vnd.api+json`.

**Expected touch points**

- `lib/publishing/publishing-api-client.js`
- `lib/publishing/publishing-api-error.js` — if the error shaping warrants its
  own module, following `lib/cloudflare/cloudflare-api-error.js`
- `test/unit-tests/lib/publishing/publishing-api-client.test.js`

**Acceptance criteria**

- [ ] Every endpoint in the contract has a method, with the correct method,
      path, media type, and body shape.
- [ ] A `404` from a stat is a result, not an error.
- [ ] `429` and `503` retry and then succeed; a fourth failure raises.
- [ ] `400` and `422` raise immediately without retrying, listing every error
      object from the document.
- [ ] `401` and `403` name the secrets file and key path.
- [ ] No test can produce the token in an error message.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/publishing-api-client.test.js`
  with an injected fetch implementation.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-5: Publish pipeline

**Status:** Not started
**Depends on:** PUB-2, PUB-3, PUB-4
**Documentation:** The stat-diff argument in the Implementation Approach above

**Objective**

Given scanned content sources, a client, and a build id, the content that should
exist in that build does exist in it, with the fewest uploads that is safe, and
the caller learns exactly what happened. This is the whole publishing behavior,
independent of any command or deployment target.

**Scope**

- In: The stat diff, bounded-concurrency uploads, the closure commit, the
  `--bootstrap` sequence, the `--dry-run` short-circuit, and the structured
  result the command renders.
- Out: Reading configuration or writing state files (PUB-6, PUB-7). Anything
  Cloudflare (PUB-8, PUB-9, PUB-10).

**Design and invariants**

- Order: stat every resource, upload the differences, commit the closure. The
  closure names the complete client-side tree, because the endpoint replaces
  rather than merges.
- Concurrency is bounded at 6 for both the stat phase and the upload phase.
- A resource uploads when its stat is `404` or reports a different hash.
  Skipping is safe only because the server itself reported the matching hash;
  never skip on any other evidence.
- `--bootstrap` exists because the resource `PUT` and stat handlers call
  `openSnapshot()`, so a build with no closure cannot be uploaded to or stated.
  It commits an empty closure for the build id first, skips the stat phase
  entirely, and uploads everything. Without it, a stat failure of this kind is
  reported as itself, naming `--bootstrap` as the remedy.
- `--dry-run` performs the scan and the stat diff and returns the same result
  shape, having made no writes. It must share the diff code path with a real
  run, not reimplement it.
- Any failure aborts before the closure. The site is untouched and uploaded
  blobs are unreferenced and inert; say so in the failure result.
- The result carries: the build id, counts of matched and uploaded resources,
  the uploaded resources with their types and pathnames, the unmatched files,
  and, for a committed publish, the closure hash and node count.
- Publishing the same tree twice is content-idempotent but still reassigns the
  build pointer. That is a feature, not a no-op to optimize away.

**Expected touch points**

- `lib/publishing/publish-content.js`
- `test/unit-tests/lib/publishing/publish-content.test.js`

**Acceptance criteria**

- [ ] An unchanged tree makes no uploads and still commits a closure.
- [ ] A changed resource uploads; its unchanged siblings do not.
- [ ] The committed tree contains every resource, including unchanged ones.
- [ ] `--bootstrap` commits an empty closure first, makes no stat requests, and
      uploads everything.
- [ ] `--dry-run` makes no `PUT` requests at all and reports the same diff.
- [ ] An upload failure prevents the closure commit.
- [ ] Concurrency never exceeds 6 in flight.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/publish-content.test.js`
  against a fake client.
- End-to-end against `node node-server.js -e staging` in `tmp/sample-app/`:
  publish, confirm a second publish uploads nothing, change one file, confirm
  exactly one upload.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-6: Target-neutral application state

**Status:** Not started
**Depends on:** None
**Documentation:** `lib/cloudflare/worker-version-state.js` is the model for shape, validation, and failure style

**Objective**

Two facts survive between commands and between machines: which build an
environment currently serves, and which builds have had content published. Both
are properties of the application, not of Cloudflare, so they live outside the
Cloudflare state file.

**Scope**

- In: `.kixx/app-state.<environment>.json` — its path, shape, validation, reads,
  and writes.
- Out: Deciding when to write it (PUB-5, PUB-7, PUB-8, PUB-9). The existing
  `cloudflare-state.<environment>.json`, which is unchanged.

**Design and invariants**

```json
{
    "liveBuildId": "2026-08-31T14-02-11Z",
    "deployedAt": "2026-08-31T14:02:40.118Z",
    "builds": {
        "2026-08-31T14-02-11Z": {
            "closureHash": "7fk2mqx4n...",
            "publishedAt": "2026-08-31T14:02:31.902Z"
        }
    }
}
```

- The file is committed with the project. `create-worker-version`'s state file
  already carries that expectation, and a rollback from another machine needs
  this history.
- `builds` is uncapped.
- Validation checks known fields and ignores unrecognized ones, so a file
  written by a newer devkit degrades rather than failing — the same policy as
  `worker-version-state.js`.
- A corrupt or unparsable file raises a `UsageError` naming the file, never a
  silent reset.
- A missing file is not an error: it means nothing has been published or
  deployed from a checkout that has this file.
- Writes are whole-file, after the operation they record has succeeded.
- Provide a predicate for "has this build ever had content published", which is
  what PUB-8's deploy guard asks.

**Expected touch points**

- `lib/app-state.js`
- `test/unit-tests/lib/app-state.test.js`

**Acceptance criteria**

- [ ] Read returns `null` for a missing file and a validated object otherwise.
- [ ] Invalid JSON, a non-object root, and a wrong-typed known field each raise
      a `UsageError` naming the file.
- [ ] An unrecognized key round-trips instead of raising.
- [ ] Recording a publish adds to `builds` without disturbing `liveBuildId`.
- [ ] Recording a deployment sets `liveBuildId` and `deployedAt` without
      disturbing `builds`.

**Validation**

- `node run-tests.js test/unit-tests/lib/app-state.test.js`
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-7: The `app publish` command

**Status:** Not started
**Depends on:** PUB-5, PUB-6
**Documentation:** `commands/README.md`; `docs/create-worker-version.md` is the model for the new document

**Objective**

`kixx.js app publish -e <environment>` publishes a project's content and is
usable on its own, for the common case of a content change with no code change.
After this task the publishing half of this plan is complete and documented.

**Scope**

- In: The new `app` top-level command and its index; the `publish` sub-command;
  configuration and build-id resolution; output rendering; `docs/publish.md`;
  the README command listing.
- Out: Anything Cloudflare (PUB-8, PUB-9, PUB-10).

**Design and invariants**

- Options: `--environment/-e` (required), `--build-id`, `--bootstrap`,
  `--dry-run`, `--verbose`, `--origin`, `--token`.
- Origin and token come from `app.environments.<environment>` in
  `.kixx/config.json` and `.kixx/secrets.json`, overridable by `--origin` and
  `--token`. Neither can be a static `requiredConfig`/`requiredSecrets` entry,
  because the runner checks those before `--environment` is parsed; validate
  inside the library and name the file and key path when a value is missing.
- Build id resolution, in order: `--build-id`, then `liveBuildId` from
  `.kixx/app-state.<environment>.json`. Neither present is a `UsageError`
  explaining that the environment has never been deployed from this checkout and
  naming both `--build-id` and `--bootstrap`.
- Default output is a summary: environment, origin, build id, counts, the
  uploaded resources, unmatched files, and the closure hash. `--verbose` lists
  every resource with its hash and disposition.
- The app-state publish record is written only after the closure commit returns.
- The command is wiring. Rendering helpers may live in the command module, as
  they do in `create-worker-version.js`; nothing else does.
- The token must not be printed, including under `--verbose`.

**Expected touch points**

- `commands/app/index.js`
- `commands/app/publish.js`
- `docs/publish.md`
- `README.md` — the command listing
- `test/unit-tests/commands/app/publish.test.js`

**Acceptance criteria**

- [ ] `node kixx.js` lists `app`; `node kixx.js app --help` lists `publish`;
      `node kixx.js app publish --help` renders options and required settings.
- [ ] A missing `--environment`, origin, or token produces a `UsageError` naming
      the file and key path, with no stack trace.
- [ ] `--dry-run` writes nothing, locally or remotely.
- [ ] A successful publish records the build in `.kixx/app-state.<env>.json`.
- [ ] A failed publish records nothing.
- [ ] `docs/publish.md` documents the options, configuration, conventions for
      all five source directories, the pipeline, the diff, `--bootstrap`, and the
      output.

**Validation**

- `node run-tests.js test/unit-tests/commands/app`
- Against `tmp/sample-app/` with `node node-server.js -e staging` running:
  `--bootstrap` publish, then an unchanged publish, then a one-file change, then
  a `--dry-run`. Confirm the sample app renders its pages from published content.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-8: The `cloudflare deploy-version` command

**Status:** Not started
**Depends on:** PUB-6
**Documentation:** `CloudflareApiClient#createDeployment()` in `lib/cloudflare/cloudflare-api-client.js`, currently unused

**Objective**

An existing Worker version can be routed all traffic as its own operation, which
is what makes rollback possible and what lets `release` separate deployment from
version creation. Deploying a version whose build has no published content is
refused, because it takes the whole site down.

**Scope**

- In: The `deploy-version` sub-command; the published-build guard; recording the
  live build after a successful deployment.
- Out: Creating versions (`create-worker-version`). Publishing (PUB-7).
  Orchestration (PUB-10).

**Design and invariants**

- Positional `[version-id]`, defaulting to `versionId` from
  `.kixx/cloudflare-state.<environment>.json`.
- The target version's `BUILD_ID` is read from Cloudflare via
  `getWorkerVersion()`, not assumed from local state, because a rollback targets
  a version this checkout may know nothing about.
- If `builds` in `.kixx/app-state.<environment>.json` has no record of that build
  id, refuse. The message states that deploying it would fail every request,
  gives the `app publish --build-id <id>` command that fixes it, and names
  `--force` as the override.
- The guard is advisory: a fresh clone may lack the record. `--force` exists for
  exactly that, and the refusal says so.
- On success, record the live build in app-state. This is what a later
  `app publish` with no `--build-id` resolves against.
- Deploying routes 100% of traffic. The output must say that plainly.

**Expected touch points**

- `commands/cloudflare/index.js` — the `deploy-version` entry
- `commands/cloudflare/deploy-version.js`
- `lib/cloudflare/deploy-worker-version.js` — if the guard and API call warrant a
  library module rather than living in the command
- `docs/deploy-version.md`, or a section of `docs/release.md` from PUB-10
- `test/unit-tests/commands/cloudflare/deploy-version.test.js`

**Acceptance criteria**

- [ ] Deploys the named version, or the recorded one when the positional is
      omitted.
- [ ] Refuses a version whose build id has no publish record, naming the
      remedy and `--force`.
- [ ] `--force` deploys anyway.
- [ ] A successful deployment updates `liveBuildId` and `deployedAt`.
- [ ] A failed deployment leaves app-state untouched.
- [ ] An unknown version id reports Cloudflare's failure as a usage error, not a
      crash.

**Validation**

- `node run-tests.js test/unit-tests/commands/cloudflare/deploy-version.test.js`
  against a fake API client.
- `node kixx.js cloudflare deploy-version --help`
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-9: `create-worker-version` records the live build

**Status:** Not started
**Depends on:** PUB-6, PUB-8
**Documentation:** `docs/create-worker-version.md`

**Objective**

Every path that puts a Worker version into service records which build the
environment now serves, so `app publish` can resolve a build id without being
told one. The existing command keeps its behavior otherwise.

**Scope**

- In: Writing the app-state live-build record when `create-worker-version`
  deploys, including the forced deployment that provisions a Durable Object
  namespace; the documentation update.
- Out: Changing the idempotency decision, the bundling, or the Cloudflare state
  file shape.

**Design and invariants**

- The recording happens only when a deployment actually occurred —
  `result.deployed` is true — and only after the version was created.
- The forced deployment path (`forcedDeploymentClasses`) counts: it routes
  traffic, so it sets the live build like any other deployment.
- Use the same app-state writer as PUB-8. Two commands must not each have their
  own idea of what the file means.
- `--deploy` on a Worker with no published content still produces a broken site.
  That is inherent to a first deployment and is the situation `--bootstrap`
  exists for; document it here and in `docs/publish.md` rather than trying to
  prevent it.

**Expected touch points**

- `lib/cloudflare/create-worker-version.js`, or
  `commands/cloudflare/create-worker-version.js` if the write belongs in the
  command alongside the other state reads
- `docs/create-worker-version.md`
- `test/unit-tests/lib/cloudflare/create-worker-version.test.js`

**Acceptance criteria**

- [ ] A deploying run records `liveBuildId` and `deployedAt`.
- [ ] A non-deploying run does not.
- [ ] A forced Durable Object deployment records it.
- [ ] A skipped run and a `resources-resolved` run record nothing.
- [ ] Existing tests still pass unchanged in intent.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare`
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task PUB-10: The `cloudflare release` command

**Status:** Not started
**Depends on:** PUB-7, PUB-8, PUB-9
**Documentation:** The release model in the Implementation Approach above

**Objective**

One command takes a working tree to production without a window in which the
deployed code has no content to serve, and reports honestly what it did at each
phase. It composes the existing commands' libraries rather than reimplementing
them.

**Scope**

- In: The `release` sub-command; phase orchestration; the unchanged-code path;
  the first-release path; combined output; `docs/release.md`.
- Out: Any new publishing, deployment, or version-creation behavior. If release
  needs something, it belongs in the library that owns it.

**Design and invariants**

Phases, and what each outcome from `createWorkerVersion()` means:

- `resources-resolved` — stop exactly as `create-worker-version` does, print the
  resolved resource ids, publish nothing, deploy nothing.
- `skipped` — no code input changed. Publish onto the live build id, and neither
  create a version nor deploy. The output states that no version was created and
  no deployment happened.
- `created` — publish under the new version's `BUILD_ID`, then deploy that
  version, then record the live build.

Invariants:

- Publishing always precedes deployment for a newly created version. This is the
  reason the command exists.
- A new build id always needs its own closure, even when every blob is
  unchanged. That publish uploads nothing and commits one closure.
- A failure after the version is created leaves that version created and
  undeployed. Nothing is live, no traffic moved, and re-running resumes. The
  failure message must say this, because an operator seeing a new version in the
  Cloudflare dashboard needs to know it is not serving.
- First release, when no app-state file exists: `create-worker-version` may force
  a deployment to provision a Durable Object namespace on a Worker that has
  never served traffic. Between that deployment and the publish, the site fails
  every request. Release must publish with `--bootstrap` immediately and report
  the window rather than hiding it.
- Output is the version phase's report followed by the publish phase's report
  followed by the deployment, so a reader can see which phase a failure belongs
  to.

**Expected touch points**

- `commands/cloudflare/index.js` — the `release` entry
- `commands/cloudflare/release.js`
- `docs/release.md`
- `README.md` — the command listing
- `test/unit-tests/commands/cloudflare/release.test.js`

**Acceptance criteria**

- [ ] A code change creates a version, publishes under its build id, deploys it,
      and records the live build, in that order.
- [ ] A content-only change publishes onto the live build and creates no version
      and no deployment, and says so.
- [ ] `resources-resolved` stops before publishing.
- [ ] A publish failure leaves the created version undeployed and says so.
- [ ] A first release with no app-state file bootstraps and reports the window.
- [ ] `docs/release.md` documents the three phases, every outcome above, the
      build-id coupling, and the recovery for each failure point.

**Validation**

- `node run-tests.js test/unit-tests/commands/cloudflare/release.test.js`
- `node kixx.js cloudflare release --help`
- A real release of `tmp/sample-app/` to a Cloudflare environment: first
  release, then a content-only change, then a code change. Confirm no request
  fails during the second and third.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


Known Upstream Issue
--------------------

The resource `PUT` handlers in the Kixx application's Publishing API call
`store.openSnapshot(context)` before writing a blob, and the stat handlers do
the same before reading an index entry. A blob write does not need the read
index. Because of this, a build with no closure can be neither uploaded to nor
stated, which is the entire reason task PUB-5 needs `--bootstrap`.

If the framework stops requiring a snapshot for a write, and returns `404`
rather than failing when a stat is issued against a build with no closure, then
`--bootstrap` becomes unnecessary and the first-release path in PUB-10 collapses
into the ordinary one. Revisit both if that changes.
