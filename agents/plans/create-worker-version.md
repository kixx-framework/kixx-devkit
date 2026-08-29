# Implementation Plan: Cloudflare create-worker-version Command

## Implementation Approach

Add `kixx.js cloudflare create-worker-version --environment <env>`, which turns a
Kixx application's source tree into a Cloudflare Worker version and uploads it.

The command is **idempotent**: running it twice with no source, binding, or
configuration change performs no write against Cloudflare. Idempotency is
achieved by recording three canonical hashes — modules, bindings, configuration —
in a git-tracked state file, and comparing them before doing any work that
creates state.

The whole feature is a linear pipeline. It is decomposed into small,
independently testable modules under `lib/`, composed by one orchestrator
function in `lib/cloudflare/create-worker-version.js`. The command module in
`commands/cloudflare/` is wiring only: parse arguments, construct the API
client, call the orchestrator, print the result, return an exit code. This
follows `commands/README.md` and keeps the idempotency logic — which is the
interesting part — reachable by unit tests rather than only through `argv`.

### Pipeline

```
validate environment config
   |
   v
getWorker(WORKER.name)          404 -> UsageError: run create-worker first
   |
   v
resolve resources               configured id -> verify it exists
   |                            null id       -> create it
   +-- anything created? -----> print ids to paste, STOP. No version created.
   |
   v
read .env.<environment>         -> secret_text values
read state file                 -> previous hashes, migrationTag, DO classes
   |
   v
build bindings (no BUILD_ID)    -> bindingsHash
bundle modules                  -> modulesHash
read WORKER_VERSION             -> configHash
plan Durable Object migrations  -> operations + old_tag/new_tag, or none
   |
   v
changed?  (any hash differs, or migrations pending, or no state, or --force)
   |
   +-- no ----------------------> print "nothing changed", exit 0
   |
   v yes
BUILD_ID = format(now())        -> injected as a plain_text binding
   |
   v
createWorkerVersion(name, payload, { deploy })
   |
   v
write state file                -> hashes, tag, classes, versionId, buildId
```

### Settled decisions

Recorded so no later agent re-opens them.

**Idempotency and state**

- A run where all three hashes match the recorded state and no Durable Object
  migration is pending performs no Cloudflare write. `--force` uploads anyway.
- State lives at `<projectDirectory>/.kixx/cloudflare-state.<environment>.json`,
  one file per environment. It is intended to be committed to git. The command
  never inspects `.gitignore` and never warns about it: developers keep their
  escape hatches.
- State is written **only after** `createWorkerVersion()` returns successfully.
  A crash in that window means the next run either re-uploads a harmless
  duplicate version, or — when a migration was applied — is rejected by
  Cloudflare's `old_tag` check, which is caught and reported with the tag to
  record by hand. The existing guard is the recovery mechanism; no pending-record
  or reconciliation protocol is invented.
- The state file is written pretty-printed with four-space indentation and a
  trailing newline, so git diffs stay line-oriented.

**Hashing**

- SHA-256, hex encoded. Canonical form is JSON with object keys sorted
  recursively and no whitespace. Arrays keep their order; a caller that wants an
  order-independent hash sorts before hashing.
- Bindings are sorted by name before hashing.
- Modules are hashed in sorted key order, not the bundler's emit order, so a
  module that merely moves position in the import graph is not a change.
- `secret_text` values are included in the bindings hash, so rotating a secret
  forces a new version. This is safe to commit: it is one digest over the entire
  binding set, so there is no per-secret digest to attack and no candidate value
  can be tested in isolation.
- `BUILD_ID` is never a hash input. It is generated only after the change
  decision is made, so it advances exactly once per uploaded version.

**Bindings**

| Type | Source |
| --- | --- |
| `d1` | `DOCUMENT_STORE` |
| `kv_namespace` | `KEY_VALUE_STORE`, and `CONTENT_STORE.kvNamespaceName`/`kvNamespaceId` |
| `durable_object_namespace` | `CONTENT_STORE.durableObjectBindingName`/`durableObjectClassName` |
| `r2_bucket` | `OBJECT_STORE.buckets` |
| `plain_text` | `ENVARS`, plus the injected `BUILD_ID` |
| `secret_text` | every key in `./.env.<environment>` |

- Every one of those config blocks is **optional**. A block that is present must
  be well-formed; a block that is absent contributes no bindings. This keeps the
  command usable by an application that does not use D1, or R2, or a content
  store. The cost is that a mistyped block name silently contributes nothing.
- A name appearing in both `ENVARS` and `.env.<environment>` is a `UsageError`
  naming the key. It is never resolved by precedence: a secret quietly demoted to
  plain text is the worst possible silent outcome.
- Duplicate binding names across any two sources are pre-checked with a message
  naming both sources, rather than relying on `CloudflareWorkerVersion`'s generic
  duplicate assertion.
- `ENVARS` values must be strings. A number or boolean is a `UsageError`, because
  a silent `String()` coercion would put `'false'` into the Worker, which is
  truthy.
- `BUILD_ID` declared in `ENVARS` is a `UsageError`; the command owns that name.
- No `version_metadata` binding is emitted.
- R2 buckets are bound verbatim and are never verified or created. The API client
  has no R2 methods and buckets are provisioned separately.

**Resources**

- `cloudflare-config.js` is authoritative for `namespaceId` and `databaseId`.
- A configured non-null id is verified with `getKVNamespace()` /
  `getD1Database()` before anything else happens, so a wrong or deleted id fails
  naming the config key rather than as an opaque binding rejection after a full
  bundle.
- A null id means the resource does not exist yet, so the command creates it.
  Every missing resource in the environment is created in one pass, then the
  command **stops** and prints each new id with the exact config key to paste it
  into. No version is created.
- The stop is what keeps provisioning and deploying apart: a run either
  provisions or deploys, never both, so a newly created resource is never used by
  the same run that made it. It does **not** make double-creation impossible. A
  developer who ignores the message and re-runs with the id still null creates a
  second resource, because Cloudflare identifies these by id rather than by name.
- The Worker itself is never created here. A 404 from `getWorker()` aborts with
  the `create-worker` invocation to run. Worker-level settings — observability,
  logpush, subdomain, tail consumers — belong to that command.

**Durable Objects**

- A class in config but not in the recorded state is added automatically as
  `new_sqlite_classes`. `new_classes` (legacy key-value backed) is never emitted.
- A class in the recorded state but not in config is a `UsageError`. Deletion is
  irreversible and a rename is indistinguishable from a delete by diff alone, so
  neither is ever inferred.
- Renames, deletions, and transfers are declared explicitly in a
  `DURABLE_OBJECT_MIGRATIONS` array in the environment config. A declaration
  whose subject is no longer in the recorded class list has already been applied
  and is a no-op, so stale declarations may sit in the config indefinitely. That
  property is what makes the declarations idempotent.
- Migration tags are `v1`, `v2`, … and advance **only** on a version that carries
  migrations. A version with no Durable Object operation omits the `migrations`
  key entirely and leaves the recorded tag untouched.

**Modules**

- The bundler entry is always `<projectDirectory>/cloudflare-server.js` and
  externals are always `[ 'node:', 'cloudflare:' ]`. Hardcoded convention, not
  configuration: the devkit already requires `cloudflare-config.js` by name.
- The bundler's `./` key prefix is stripped when building the Cloudflare payload,
  so Cloudflare sees `cloudflare-server.js` and `kixx/logger/logger.js` — the
  naming wrangler produces. Unrewritten relative specifiers still resolve,
  because resolution is relative to the importing module's name. Target-specific
  naming belongs in the target adapter, which the module-bundler plan explicitly
  left out of scope.

**Version metadata**

- `WORKER_VERSION` is a per-environment block holding exactly the version-level
  fields Cloudflare accepts: `compatibility_date`, `compatibility_flags`,
  `limits`, `placement`, `cache_options`. It is passed through verbatim, so the
  configuration hash is simply the canonical hash of the block and no field
  picking logic exists. `WORKER` stays the verbatim `create-worker` payload; the
  two never bleed into each other.
- Annotations are generated, never authored: `workers/tag` is the `BUILD_ID` and
  `workers/triggered_by` names the command. No `workers/message` is sent and
  there is no `--message` option.
- The command creates a version and routes no traffic. `--deploy` sets the
  `deploy` option on `createWorkerVersion()` so the new version takes 100% of
  traffic.

**Testing**

- Unit tests only, per `test/README.md`. Every dependency a test needs to control
  is **injected**: the filesystem adapter, the API client, `bundleModules`, and
  the clock. No test monkey-patches a module or a global. No end-to-end tests.
- The orchestrator is tested against a stub bundler and a mock API client, so the
  skip / create / migrate decision logic is exercised with no files on disk.
- A manual run against `tmp/app` is recorded as a human verification step in the
  relevant tasks. It is not a test and is never automated. `tmp/` is gitignored,
  so `tmp/app` is a disposable target, never a fixture.

### Discovered constraint: API errors carry no status

`CloudflareAPIClient#fetchResult()` throws a bare `Error` whose only record of
the HTTP status is inside the message text. Three decisions above depend on
telling a 404 apart from every other failure — a missing Worker, a missing KV
namespace, a missing D1 database — and one depends on recognizing a rejected
`old_tag`. Matching on message text would couple this feature to a string.

Task 2 therefore introduces `CloudflareApiError` carrying `status` and the
Cloudflare error array, following the shape already established by
`lib/usage-error.js` and `lib/bundler/bundle-error.js`.

**Open question for the implementing agent to resolve and record:** Cloudflare
sometimes reports a missing resource as HTTP 404 and sometimes as HTTP 200 with
`success: false` and an error code. This plan treats **HTTP 404 only** as
"absent". If the manual verification in Task 12 shows a missing KV namespace or
D1 database arriving as a 200 envelope, extend the absence test to cover the
observed error code and record the code and the observation in that task's
handoff notes.

### Config additions required

`cloudflare-config.js` gains, per environment:

```js
ENVARS: {
    APP_NAME: 'kixx-test-app',
    ENVIRONMENT: 'production',
    LOG_LEVEL: 'info',
},

// Optional. Only needed to rename, delete, or transfer a Durable Object class.
DURABLE_OBJECT_MIGRATIONS: [
    { action: 'rename', from: 'OldName', to: 'NewName' },
    { action: 'delete', className: 'DeadName' },
    { action: 'transfer', from: 'Name', fromScript: 'old-worker', to: 'Name' },
],
```

`WORKER_VERSION` already exists in `tmp/app/cloudflare-config.js`. `ENVARS` does
not, and must be added there before the Task 12 manual check can run.

### Module layout

```
lib/
    file-system.js                        <- moved from lib/bundler/, gains writeFile
    canonical-hash.js                     <- new
    env-file.js                           <- new
    cloudflare/
        cloudflare-api-error.js           <- new
        cloudflare-api-client.js          <- modified to throw CloudflareApiError
        cloudflare-worker-version.js      <- unchanged
        worker-version-state.js           <- new
        worker-modules.js                 <- new
        worker-bindings.js                <- new
        durable-object-migrations.js      <- new
        provision-resources.js            <- new
        build-id.js                       <- new
        create-worker-version.js          <- new, the orchestrator
commands/
    cloudflare/
        index.js                          <- new subcommands entry
        create-worker-version.js          <- new, wiring only
```

---

### Task 1: Relocate the filesystem adapter and add writeFile

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/plans/module-bundler.md` (Task 2), `test/README.md`

**Objective**

The project has exactly one injectable filesystem adapter, at
`lib/file-system.js`, serving both the bundler and the new Cloudflare version
modules. It gains a `writeFile` operation. No module outside it imports
`node:fs/promises`.

**Scope**

- In: moving `lib/bundler/file-system.js` to `lib/file-system.js`, adding
  `writeFile`, updating every import of it, moving its test file, and updating
  the `module-bundler.md` references to its path.
- Out: every consumer of `writeFile` (Tasks 5 and 10).

**Design and invariants**

- The four operations are `readFile`, `writeFile`, `realpath`, and `isFile`.
  `realpath` stays even though only the bundler uses it: the adapter is one
  contract for the project, and a mock supplying an unused method is cheaper than
  two adapters that drift.
- `writeFile(filepath, contents)` writes UTF-8 and creates the parent directory
  recursively first. Creating the directory inside the adapter keeps a
  `mkdir` concern out of every caller and keeps the interface at four methods
  rather than five. The state file lives under `.kixx/`, which normally exists
  because the project directory is discovered by its presence — but the loader
  falls back to the working directory when no project is found, so the directory
  cannot be assumed.
- The adapter stays a frozen plain object of functions. It holds no state, and a
  class would be exactly the thin wrapper the style guide rejects.
- The default adapter remains the module default export, so callers can use it as
  an option default.
- `isFile()` keeps its documented behavior: `false` for a missing path and for a
  directory, with any error that is not about absence propagating.
- This task moves and extends completed, tested work. The existing tests move
  with the module and must still pass unchanged apart from the import path.

**Expected touch points**

- `lib/file-system.js` — moved from `lib/bundler/file-system.js`, plus `writeFile`.
- `lib/bundler/bundle-modules.js` — import path.
- `lib/bundler/resolve-specifier.js` — import path, if it imports the adapter.
- `test/unit-tests/lib/file-system.test.js` — moved test file, plus `writeFile` cases.
- `agents/plans/module-bundler.md` — the path references in Task 2 and Task 4.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `lib/file-system.js` default-exports an adapter providing `readFile`,
      `writeFile`, `realpath`, and `isFile`.
- [ ] `lib/bundler/file-system.js` no longer exists and nothing imports it.
- [ ] `writeFile()` creates a missing parent directory and writes UTF-8.
- [ ] `writeFile()` overwrites an existing file.
- [ ] Every pre-existing `file-system` test still passes.
- [ ] The `FileSystem` typedef documents all four operations.
- [ ] `agents/plans/module-bundler.md` names the new path.

**Validation**

- `node run-tests.js test/unit-tests/lib/file-system.test.js`
- `node run-tests.js test/unit-tests/lib/bundler` — proves the move broke nothing.
- `node run-linter.js lib/file-system.js lib/bundler test/unit-tests/lib`
- `grep -rn "node:fs" lib/` returns only `lib/file-system.js` and
  `lib/config-loader.js` (the latter predates the adapter and is out of scope).
- `grep -rn "bundler/file-system" .` returns nothing.
- Tests exercise the adapter against a real temporary directory, since this
  module is precisely the boundary a mock cannot verify.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 2: CloudflareApiError carrying the HTTP status

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `lib/usage-error.js`, `lib/bundler/bundle-error.js`

**Objective**

A failed Cloudflare API call throws an error a caller can branch on. The HTTP
status and the Cloudflare error array are properties, not text buried in a
message, so "this resource does not exist" is distinguishable from "the token is
wrong" without matching a string.

**Scope**

- In: `lib/cloudflare/cloudflare-api-error.js`, and the two throw sites in
  `CloudflareAPIClient#fetchResult()`.
- Out: every caller that branches on the status (Tasks 9 and 10); any change to
  the client's method signatures or URLs.

**Design and invariants**

- `CloudflareApiError extends Error`, with `name` and `code` defined from
  `this.constructor.name` as enumerable own properties, matching `UsageError` and
  `BundleError`. That is what lets a top-level handler branch without importing
  the class.
- Properties: `status` (the HTTP status number), `errors` (the Cloudflare error
  array, or an empty array), `method`, and `url`. All enumerable own properties.
- The message text is unchanged from what the client produces today. This task
  adds structure; it does not alter what a user sees in an unhandled failure.
- Both throw sites in `#fetchResult()` are converted: the non-2xx branch sets the
  real status, and the `success: false` envelope branch sets the response status
  (which may be 200).
- Store a copy of the errors array, not the parsed reference.
- The class carries no behavior beyond construction. It is not given helpers like
  `isNotFound()`; a caller comparing `status === 404` is clearer than a predicate
  that hides the number.

**Expected touch points**

- `lib/cloudflare/cloudflare-api-error.js` — new module.
- `lib/cloudflare/cloudflare-api-client.js` — the two throw sites and the
  `@throws` tags on every public method.
- `test/unit-tests/lib/cloudflare/cloudflare-api-error.test.js` — new test file.
- `test/unit-tests/lib/cloudflare/cloudflare-api-client.test.js` — existing tests
  asserting on the thrown error, if any.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `name` and `code` are `'CloudflareApiError'` as enumerable own properties.
- [ ] A non-2xx response throws with `status` set to the real HTTP status.
- [ ] A 200 response with `success: false` throws with `status` 200 and `errors`
      populated from the envelope.
- [ ] `errors` is an array even when the envelope carried none.
- [ ] `errors` is not the same object reference as the parsed envelope's array.
- [ ] The thrown message text matches what the client produced before this task.
- [ ] Every public client method's `@throws` tag names `CloudflareApiError`.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare`
- `node run-linter.js lib/cloudflare test/unit-tests/lib/cloudflare`
- Tests inject a `fetch` implementation rather than patching the global. If the
  client does not currently accept an injected `fetch`, add it as a constructor
  option defaulting to the global, and record that in the handoff notes.
- Unit tests cover: the non-2xx branch, the unsuccessful-envelope branch, the
  empty-errors case, and defensive copying.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 3: Canonical hashing

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `test/README.md`

**Objective**

One module turns any JSON-representable value into a deterministic string and
that string into a SHA-256 hex digest. Two structurally equal values always
produce the same digest regardless of key insertion order, on any platform, in
any process.

**Scope**

- In: `lib/canonical-hash.js` — `canonicalize()`, `sha256Hex()`, and
  `hashValue()`.
- Out: deciding what to hash (Tasks 6, 7, and 10); the module-specific digest
  form, which belongs to `worker-modules.js` because it owns the module shape.

**Design and invariants**

- `canonicalize(value)` emits JSON with object keys sorted with a plain
  `Array#sort()` on the key strings, applied recursively. Array order is
  preserved: order is meaningful in `compatibility_flags`, and a caller wanting
  order independence sorts before calling.
- No whitespace. The output is a hash input, never something a human reads.
- `undefined` object values are omitted, matching `JSON.stringify`. An
  `undefined` array element becomes `null`, also matching `JSON.stringify`.
- A non-JSON-representable input — a function, a `BigInt`, a circular reference —
  throws rather than silently producing a digest over a partial structure. A
  digest that quietly ignores part of its input is worse than no digest.
- `sha256Hex(text)` uses `node:crypto` `createHash('sha256')` over the UTF-8
  encoding and returns lowercase hex. It takes a string, not a value, so a caller
  with its own canonical form (Task 6) can use it directly.
- `hashValue(value)` is `sha256Hex(canonicalize(value))`. It exists because that
  pairing is what every caller wants, and naming it stops each caller from
  re-deriving it.
- These are pure functions in a module, not a class. There is no state.

**Expected touch points**

- `lib/canonical-hash.js` — new module.
- `test/unit-tests/lib/canonical-hash.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Two objects with the same entries in different insertion orders
      canonicalize identically and hash identically.
- [ ] Nested objects are sorted at every depth.
- [ ] Array order is preserved and two arrays differing only in order hash
      differently.
- [ ] Output contains no whitespace.
- [ ] `undefined` object values are omitted; `null` values are kept and are
      distinguishable from an absent key.
- [ ] Numbers, booleans, `null`, and strings with non-ASCII and escaped
      characters all round-trip to a stable digest.
- [ ] A circular reference throws.
- [ ] A function or `BigInt` value throws.
- [ ] `sha256Hex()` returns 64 lowercase hex characters and matches a known
      vector for a known input.

**Validation**

- `node run-tests.js test/unit-tests/lib/canonical-hash.test.js`
- `node run-linter.js lib/canonical-hash.js test/unit-tests/lib/canonical-hash.test.js`
- A test pinning `sha256Hex('')` to the published empty-string SHA-256 digest,
  proving the encoding and the algorithm rather than only self-consistency.
- Unit tests need no filesystem and no mocks; this module is pure.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 4: Environment file reader

**Status:** Not started
**Depends on:** Task 1
**Documentation:** `agents/docs/code-style-guide.md`, `test/README.md`

**Objective**

`./.env.<environment>` is parsed into a plain object of name to string value,
with rules chosen so a secret is never silently corrupted by parsing.

**Scope**

- In: `lib/env-file.js` — locating the file for an environment, reading it
  through the injected adapter, and parsing it.
- Out: turning the result into bindings (Task 7); any notion of Cloudflare.

**Design and invariants**

- `readEnvFile(args)` takes `{ projectDirectory, environment, fileSystem }` and
  resolves to a plain object. One options object, destructured in the body, per
  the style guide.
- The filepath is `<projectDirectory>/.env.<environment>`.
- A missing file is a `UsageError` naming the expected path. It is not treated as
  "no secrets": an application deploying with zero secrets is far less likely
  than a mistyped environment name, and silently deploying without secrets is a
  production outage.
- Parsing rules, deliberately minimal:
  - Blank lines are skipped.
  - A line whose first non-whitespace character is `#` is a comment.
  - Every other line must match `NAME=value`. A line that does not is a
    `UsageError` naming the file and the line number.
  - `NAME` must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. It is trimmed.
  - The value is everything after the first `=`. Leading and trailing whitespace
    is trimmed.
  - A value wholly wrapped in matching single or double quotes has exactly that
    one pair stripped. Nothing else is unescaped.
  - **There are no inline comments.** A `#` after a value is part of the value.
    Treating it as a comment would silently truncate any secret containing `#`,
    which is a realistic character in a generated token.
  - There is no variable expansion, no multi-line value, and no `export` prefix.
    Each is a way for a secret to arrive at Cloudflare different from how it
    reads in the file.
- A duplicate name is a `UsageError` naming the key and both line numbers. Silent
  last-wins over a secret is not acceptable.
- An empty value is legal. An empty string is a meaningful configuration value
  and `CloudflareWorkerVersion` accepts it for a text field.
- The returned object is a null-prototype object or is otherwise safe against a
  key named `__proto__` or `constructor` reaching a prototype.

**Expected touch points**

- `lib/env-file.js` — new module.
- `test/unit-tests/lib/env-file.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Returns a plain object of name to string for a well-formed file.
- [ ] A missing file throws a `UsageError` naming the expected path.
- [ ] Blank lines and full-line comments are skipped.
- [ ] A `#` inside a value is preserved.
- [ ] One layer of matching single or double quotes is stripped; an inner quote
      of the other kind survives.
- [ ] An empty value yields an empty string.
- [ ] A malformed line throws a `UsageError` naming the line number.
- [ ] An invalid name throws a `UsageError` naming the key.
- [ ] A duplicate name throws a `UsageError` naming both line numbers.
- [ ] A key named `__proto__` does not pollute the returned object's prototype.
- [ ] `\r\n` line endings parse identically to `\n`.

**Validation**

- `node run-tests.js test/unit-tests/lib/env-file.test.js`
- `node run-linter.js lib/env-file.js test/unit-tests/lib/env-file.test.js`
- Tests inject a mock `FileSystem` built from a file-local `makeFileSystem(files)`
  helper over a map of absolute path to contents, per the `test/README.md`
  preference for file-local helpers. No test touches a real file.
- A test parsing a copy of the sample `example.env` content, proving the real
  shape works including its comment blocks.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 5: Worker version state file

**Status:** Not started
**Depends on:** Task 1
**Documentation:** `agents/docs/code-style-guide.md`, `test/README.md`

**Objective**

The durable record of the last created version is read and written through one
module, which owns its path, its shape, and its validation. A corrupt or
hand-mangled state file fails with a message naming the file, never by producing
a wrong idempotency decision.

**Scope**

- In: `lib/cloudflare/worker-version-state.js` — the filepath derivation, the
  reader, the writer, and shape validation.
- Out: deciding what goes in the state (Task 10); comparing hashes (Task 10).

**Design and invariants**

- Three exports: `getStateFilepath({ projectDirectory, environment })`,
  `readWorkerVersionState({ projectDirectory, environment, fileSystem })`, and
  `writeWorkerVersionState({ projectDirectory, environment, state, fileSystem })`.
  The filepath function is exported because the command prints the path and the
  orchestrator reports it.
- The filepath is
  `<projectDirectory>/.kixx/cloudflare-state.<environment>.json`.
- An absent file resolves to `null`, not an empty object. "Never deployed" is a
  distinct state from "deployed with empty hashes", and a caller must handle it
  deliberately — a first run has no hashes to compare and must always upload.
- A file that exists but is not valid JSON, or is not a JSON object, is a
  `UsageError` naming the path. It is never treated as absent: silently
  discarding a corrupt state file would re-run migrations.
- Field validation on read: each recorded field, when present, must have the
  right type — the three hashes and `migrationTag` strings or `null`,
  `durableObjectClasses` an array of strings, `deployed` a boolean. A wrong type
  is a `UsageError` naming the field. Unknown keys are preserved on read and
  written back untouched, so a newer devkit's field is not destroyed by an older
  one.
- Recorded shape:

```json
{
    "workerName": "kixx-test-app",
    "buildId": "2026-08-29T16-49-32Z",
    "versionId": "a1b2c3d4-...",
    "createdAt": "2026-08-29T16:49:32.000Z",
    "deployed": false,
    "modulesHash": "4f2a...",
    "bindingsHash": "9c1e...",
    "configHash": "77bd...",
    "migrationTag": "v1",
    "durableObjectClasses": [ "ContentAddressableIndexStore" ]
}
```

- `migrationTag` is `null` when the Worker has never had a migration.
  `durableObjectClasses` is `[]` when it has no Durable Objects.
- The writer serializes with `JSON.stringify(state, null, 4)` plus a trailing
  newline, matching the four-space convention used elsewhere in the project and
  keeping git diffs line-oriented.
- The writer writes the object it is given. It does not merge with what is on
  disk: the orchestrator builds the complete next state, and a merge here would
  hide which fields a run actually set.
- All filesystem access goes through the injected adapter. This module never
  imports `node:fs/promises`.

**Expected touch points**

- `lib/cloudflare/worker-version-state.js` — new module.
- `test/unit-tests/lib/cloudflare/worker-version-state.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `getStateFilepath()` returns the documented path for an environment.
- [ ] Reading an absent file resolves to `null`.
- [ ] Reading a valid file returns its parsed object.
- [ ] Invalid JSON throws a `UsageError` naming the path.
- [ ] A non-object top level throws a `UsageError` naming the path.
- [ ] A wrong-typed known field throws a `UsageError` naming the field.
- [ ] An unknown key survives a read-then-write round trip.
- [ ] The written text is four-space indented and ends with exactly one newline.
- [ ] The writer creates `.kixx/` when it does not exist.
- [ ] A read-then-write round trip of a valid state produces identical text.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/worker-version-state.test.js`
- `node run-linter.js lib/cloudflare test/unit-tests/lib/cloudflare`
- Tests inject a mock `FileSystem` whose `writeFile` records its arguments, so
  the exact serialized text is asserted. No test touches a real file.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 6: Worker modules adapter

**Status:** Not started
**Depends on:** Task 3
**Documentation:** `agents/docs/code-style-guide.md`, `agents/plans/module-bundler.md`, `lib/cloudflare/cloudflare-worker-version.js`, `test/README.md`

**Objective**

A bundle from `bundleModules()` becomes the module list Cloudflare accepts, with
wrangler-style names, and a stable digest over that list. This module owns the
`./` prefix translation and the module canonical form.

**Scope**

- In: `lib/cloudflare/worker-modules.js` — `toWorkerModules(bundle)` and
  `hashWorkerModules(modules)`.
- Out: adding modules to `CloudflareWorkerVersion` (Task 10); running the
  bundler (Task 10).

**Design and invariants**

- `toWorkerModules(bundle)` takes the bundler's `{ entry, modules }` and returns
  `{ mainModule, modules }` where `modules` is an array of `{ name, content }`.
- The `./` prefix is stripped from every key and from the entry. Cloudflare and
  wrangler name modules without it, and this is the adapter boundary where
  target-specific naming belongs. The bundler's key namespace is unchanged.
- A key that does not start with `./` is an assertion failure, not a silent
  pass-through. The bundler's documented contract guarantees the prefix, and a
  key without it means the contract changed underneath this module.
- Module order in the returned array is the bundler's emit order, so the entry
  comes first and the uploaded payload is stable. Ordering for the digest is a
  separate concern handled below.
- `content` is the module source verbatim. Base64 encoding is
  `CloudflareWorkerVersion#addModule()`'s job and is not duplicated here.
- Content type is not set. `addModule()` infers
  `application/javascript+module` from the `.js` extension, and every module the
  bundler emits is `.js` or `.mjs`.
- `hashWorkerModules(modules)` sorts by name, then builds the digest input as,
  for each module, the name, the UTF-8 byte length of the source, and the source,
  each followed by a newline. The byte length is a length delimiter: without it,
  a module name ending in a newline could in principle produce the same
  concatenation as a different module set. Sorting by name rather than emit order
  means a module that only moves position in the import graph is not a change.
- The digest is `sha256Hex()` from `lib/canonical-hash.js` over that string.
  `canonicalize()` is not used: JSON-encoding megabytes of source only to hash it
  would double the work for no determinism gain.

**Expected touch points**

- `lib/cloudflare/worker-modules.js` — new module.
- `test/unit-tests/lib/cloudflare/worker-modules.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `toWorkerModules()` returns `mainModule` as the entry key without `./`.
- [ ] Every returned module name has no `./` prefix and keeps its full relative
      path with `/` separators.
- [ ] The returned array's first element is the entry.
- [ ] Module sources are returned verbatim, byte for byte.
- [ ] A key without a `./` prefix throws.
- [ ] `hashWorkerModules()` returns the same digest for two module arrays
      differing only in order.
- [ ] Changing one byte of one module's source changes the digest.
- [ ] Renaming a module changes the digest.
- [ ] Adding a module changes the digest.
- [ ] Two modules whose names and sources concatenate ambiguously produce
      different digests, pinning the length delimiter.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/worker-modules.test.js`
- `node run-linter.js lib/cloudflare test/unit-tests/lib/cloudflare`
- Tests build `{ entry, modules }` objects from file-local literals. This module
  is pure and needs no mocks beyond that.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 7: Worker bindings assembly

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `lib/cloudflare/cloudflare-worker-version.js`, `test/README.md`

**Objective**

The environment's configuration blocks and its parsed `.env` file become one
validated, deterministically ordered array of Cloudflare binding definitions.
Every way of getting bindings wrong is caught here, with a message naming the
config key or the `.env` key at fault.

**Scope**

- In: `lib/cloudflare/worker-bindings.js` — reading the six sources, validating
  each, detecting collisions, and ordering the result.
- Out: reading the `.env` file (Task 4); injecting `BUILD_ID` (Task 10);
  hashing (Task 10); resolving resource ids (Task 9).

**Design and invariants**

- `buildWorkerBindings(args)` takes `{ environmentConfig, secrets }` and returns
  an array of binding objects in the shape `CloudflareWorkerVersion#addBinding()`
  accepts.
- **The returned array never contains `BUILD_ID`.** The array is the bindings
  hash input, and `BUILD_ID` is generated only after the change decision. The
  orchestrator appends it. This is stated in the module documentation, because a
  future caller that adds it here would silently destroy idempotency.
- Sources, all optional:

| Config | Produces |
| --- | --- |
| `DOCUMENT_STORE` | one `d1` from `bindingName` and `databaseId` |
| `KEY_VALUE_STORE` | one `kv_namespace` from `bindingName` and `namespaceId` |
| `CONTENT_STORE` | one `kv_namespace` from `kvBindingName` and `kvNamespaceId`, and one `durable_object_namespace` from `durableObjectBindingName` and `durableObjectClassName` |
| `OBJECT_STORE.buckets` | one `r2_bucket` per entry, from `bindingName` and `bucketName` |
| `ENVARS` | one `plain_text` per entry |
| `secrets` | one `secret_text` per entry |

- A block that is absent contributes nothing. A block that is present must be
  well-formed: a missing or empty required field is a `UsageError` naming the
  full dotted config path, such as
  `environments.production.DOCUMENT_STORE.bindingName`.
- A null `databaseId`, `namespaceId`, or `kvNamespaceId` reaching this function is
  an error. Task 9 resolves ids and stops the run before this point when any is
  missing, so a null here means the pipeline was composed wrongly.
- `ENVARS` values must be strings. A number, boolean, `null`, or object is a
  `UsageError` naming the key and its actual type. No coercion.
- `ENVARS` may not declare `BUILD_ID`; that is a `UsageError`.
- A name present in both `ENVARS` and `secrets` is a `UsageError` naming the key
  and both files. It is never resolved by precedence.
- Any duplicate binding name across any two sources is a `UsageError` naming the
  name and both contributing sources. This runs before
  `CloudflareWorkerVersion#addBinding()`, whose own duplicate assertion is
  correct but cannot say where the two came from.
- The returned array is sorted by binding name. Sorting here means the array is
  hash-ready without the caller re-sorting, and the uploaded payload order is
  stable, which makes two identical deploys byte-identical.
- This module performs no I/O and makes no API calls. It is a pure function of
  its two inputs, which is what makes its many failure cases cheap to test.

**Expected touch points**

- `lib/cloudflare/worker-bindings.js` — new module.
- `test/unit-tests/lib/cloudflare/worker-bindings.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A full sample environment produces exactly the expected binding set: one
      `d1`, two `kv_namespace`, one `durable_object_namespace`, the configured
      `r2_bucket` entries, one `plain_text` per `ENVARS` entry, and one
      `secret_text` per `.env` key.
- [ ] `BUILD_ID` is absent from the result even when `secrets` or `ENVARS`
      contain unrelated keys.
- [ ] An empty `OBJECT_STORE.buckets` produces no `r2_bucket` bindings.
- [ ] Every config block is independently omittable, and omitting all of them
      with empty secrets yields an empty array.
- [ ] A missing required field in a present block throws a `UsageError` naming
      the full dotted config path.
- [ ] A null resource id throws.
- [ ] A non-string `ENVARS` value throws naming the key and its type.
- [ ] `ENVARS.BUILD_ID` throws.
- [ ] A name in both `ENVARS` and `secrets` throws naming both sources.
- [ ] A duplicate name across two config blocks throws naming both sources.
- [ ] The result is sorted by name, and reordering the input object keys does not
      change the output.
- [ ] An empty-string secret value produces a `secret_text` binding with an empty
      `text`.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/worker-bindings.test.js`
- `node run-linter.js lib/cloudflare test/unit-tests/lib/cloudflare`
- A test asserting every returned binding is accepted by
  `CloudflareWorkerVersion#addBinding()` without throwing, pinning the two
  modules' shapes together.
- Tests build config objects from a file-local helper that returns a complete
  valid environment, with each test overriding the one field it is about.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 8: Durable Object migration planning

**Status:** Not started
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `tmp/worker-versions-migrations.md`, `lib/cloudflare/cloudflare-worker-version.js`, `test/README.md`

**Objective**

The recorded class list, the configured class list, and the explicit migration
declarations become either a complete migration plan with its tag pair, or
nothing. A class disappearing without a declaration never becomes a deletion.

**Scope**

- In: `lib/cloudflare/durable-object-migrations.js` — collecting configured
  classes, applying declarations, diffing, computing the tag pair, and computing
  the next recorded class list.
- Out: calling `CloudflareWorkerVersion`'s migration methods (Task 10); the
  Durable Object bindings themselves (Task 7).

**Design and invariants**

- `planDurableObjectMigrations(args)` takes
  `{ environmentConfig, recordedClasses, migrationTag }` and returns
  `{ operations, oldTag, newTag, nextClasses }`, with `operations` `null` when
  there is nothing to do.
- Configured classes are collected from `CONTENT_STORE.durableObjectClassName`.
  The collection is written as a list from the start, so a second Durable Object
  source is one line to add rather than a refactor.
- Declarations come from `environmentConfig.DURABLE_OBJECT_MIGRATIONS`, an
  optional array. Each entry is one of:
  - `{ action: 'rename', from, to }`
  - `{ action: 'delete', className }`
  - `{ action: 'transfer', from, fromScript, to }`
  A malformed entry is a `UsageError` naming its index and what is wrong.
- **Declarations are idempotent by subject.** A declaration applies only when its
  subject is still in the recorded class list — `from` for a rename, `className`
  for a delete, and for a transfer, when `to` is *not* yet recorded. Once applied
  and recorded, the same declaration is a no-op forever. This is what lets a
  declaration stay in the config file indefinitely instead of needing to be
  deleted after one deploy, and it is why the plan never needs a
  "declarations already applied" list in the state file.
- Algorithm, in order:
  1. Start from `recordedClasses`.
  2. Apply each applicable declaration in array order, accumulating
     `renamed_classes`, `deleted_classes`, and `transferred_classes`, and
     updating the working class list as each applies.
  3. Configured classes absent from the working list become
     `new_sqlite_classes`, and are appended to the working list.
  4. Any class remaining in the working list that is not configured is a
     `UsageError` naming the class and instructing the developer to declare a
     rename or a delete in `DURABLE_OBJECT_MIGRATIONS`. This is the guard that
     makes deletion impossible to trigger by accident.
- `new_classes` is never produced. It is the legacy key-value backend and applies
  only to namespaces that already exist on it, which cannot be the case for a
  class this tool is creating.
- Tags: when `operations` is non-null, `oldTag` is the recorded `migrationTag`
  — `null` when the Worker has never migrated — and `newTag` is `v<N+1>` where
  `N` is parsed from the recorded tag, or `v1` when there is none. A recorded tag
  that does not match `/^v(\d+)$/` is a `UsageError`, since the successor cannot
  be derived and guessing would break Cloudflare's guard.
- When `operations` is `null`, `oldTag` and `newTag` are `null` and `nextClasses`
  equals the configured list. A version with no Durable Object change must not
  advance the tag.
- `nextClasses` is always returned sorted, so the state file's array does not
  churn in git for ordering reasons alone.
- The module performs no I/O and makes no API calls.

**Expected touch points**

- `lib/cloudflare/durable-object-migrations.js` — new module.
- `test/unit-tests/lib/cloudflare/durable-object-migrations.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] No recorded classes and one configured class produces
      `new_sqlite_classes: [ 'X' ]`, `oldTag` `null`, `newTag` `'v1'`.
- [ ] Recorded equals configured and no declarations produces `operations` `null`
      and leaves the tag untouched.
- [ ] Adding a second configured class produces only that class in
      `new_sqlite_classes`.
- [ ] A recorded class absent from config with no declaration throws a
      `UsageError` naming the class.
- [ ] A rename declaration produces `renamed_classes` and the renamed class in
      `nextClasses`.
- [ ] The same rename declaration, once recorded, produces `operations` `null` on
      the next run.
- [ ] A delete declaration produces `deleted_classes` and removes the class.
- [ ] The same delete declaration, once recorded, is a no-op.
- [ ] A transfer declaration produces `transferred_classes` and adds `to`.
- [ ] The same transfer declaration, once recorded, is a no-op.
- [ ] A rename plus a new class in one run produces both operation kinds under
      one tag pair.
- [ ] `oldTag` `'v3'` yields `newTag` `'v4'`.
- [ ] A recorded tag of `'release-2'` throws.
- [ ] A malformed declaration throws naming its index.
- [ ] `new_classes` is never present in the output.
- [ ] `nextClasses` is sorted.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/durable-object-migrations.test.js`
- `node run-linter.js lib/cloudflare test/unit-tests/lib/cloudflare`
- A test feeding the produced operations into `CloudflareWorkerVersion`'s
  `addNewSqliteClass()`, `renameClass()`, `deleteClass()`, `transferClass()`, and
  `setMigrationTags()`, then asserting `toJSON().migrations` matches the expected
  payload. This pins the two modules' vocabularies together, which is the seam
  most likely to drift.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 9: Resource resolution and provisioning

**Status:** Not started
**Depends on:** Task 2
**Documentation:** `agents/docs/code-style-guide.md`, `lib/cloudflare/cloudflare-api-client.js`, `test/README.md`

**Objective**

Every KV namespace and D1 database the environment's configuration requires is
known to exist before anything else happens. A configured id that does not exist
fails naming the config key. A null id is created, and every creation in the
environment happens in one pass so the developer has exactly one edit to make.

**Scope**

- In: `lib/cloudflare/provision-resources.js` — enumerating required resources
  from the config, verifying configured ids, creating missing resources, and
  reporting what was created.
- Out: deciding to stop the run after a creation (Task 10); R2 buckets, which are
  never verified or created; the Worker itself (Task 10).

**Design and invariants**

- `resolveResources(args)` takes `{ environment, environmentConfig, apiClient }`
  and resolves to `{ created }`, an array of
  `{ configKeyPath, kind, name, id }` describing every resource created during
  this call. An empty array means everything already existed.
- Required resources, each contributed only when its config block is present:

| Config key path | Kind | Name field | Id field |
| --- | --- | --- | --- |
| `DOCUMENT_STORE` | d1 | `databaseName` | `databaseId` |
| `KEY_VALUE_STORE` | kv | `namespaceName` | `namespaceId` |
| `CONTENT_STORE` | kv | `kvNamespaceName` | `kvNamespaceId` |

- For each: a non-null id is verified with `getKVNamespace()` or
  `getD1Database()`. A `CloudflareApiError` with `status` 404 becomes a
  `UsageError` naming the full dotted config key and the id that was not found.
  Any other error propagates unchanged — a bad token or a network failure must
  not be reported as a missing namespace.
- A null id means the resource is created with `createKVNamespace({ title })` or
  `createD1Database({ name })`, using the configured name.
- **Every resource is processed before returning.** The pass does not stop at the
  first creation, so a developer with three unprovisioned resources gets three
  ids in one message rather than three runs. A verification failure, by contrast,
  throws immediately: a wrong id is a config error to fix, not a list to
  accumulate.
- The module never writes to `cloudflare-config.js`. The config is authoritative
  and is edited by a human; generating JavaScript back into a hand-maintained
  module with comments would be lossy.
- The module makes no decision about whether the run continues. It reports what
  it created; the orchestrator owns the stop.
- The API client is injected. This module never constructs one.
- See the open question in the Implementation Approach: this task treats HTTP 404
  alone as absence. If verification of a genuinely missing resource is observed
  to arrive as a 200 envelope with an error code, extend the absence test and
  record the observed code here.

**Expected touch points**

- `lib/cloudflare/provision-resources.js` — new module.
- `test/unit-tests/lib/cloudflare/provision-resources.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] All ids configured and all verified returns `created` empty, having called
      `getKVNamespace()` twice and `getD1Database()` once.
- [ ] A configured id returning a 404 throws a `UsageError` naming the dotted
      config key and the id.
- [ ] A configured id returning a 401 or a network error propagates that error
      unchanged.
- [ ] A null id creates the resource with the configured name and reports it in
      `created` with its dotted config key.
- [ ] Three null ids produce three entries in `created` from one call.
- [ ] An absent config block contributes no calls and no entries.
- [ ] A present block missing its name field, with a null id, throws a
      `UsageError` naming the key rather than creating a nameless resource.
- [ ] No R2 call is ever made.
- [ ] `cloudflare-config.js` is never written.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/provision-resources.test.js`
- `node run-linter.js lib/cloudflare test/unit-tests/lib/cloudflare`
- Tests inject a mock API client built from a file-local helper: an object whose
  methods resolve from a per-test map or reject with a constructed
  `CloudflareApiError`, recording every call. `mock.callCount()` pins that an
  absent block causes no calls.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 10: Build ID and the orchestrator

**Status:** Not started
**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `lib/cloudflare/cloudflare-worker-version.js`, `lib/bundler/bundle-modules.js`, `test/README.md`

**Objective**

One function composes every module above into the documented pipeline and owns
the idempotency decision. Given an environment, it either skips, or reports
resources it created and stops, or creates a version and records the new state.
It is fully driveable by injected dependencies, so every branch is unit testable
without a filesystem, a network, or a clock.

**Scope**

- In: `lib/cloudflare/build-id.js`, and `lib/cloudflare/create-worker-version.js`
  — option handling, config validation, the Worker existence check, the change
  decision, payload assembly, the upload, the state write, and the result object.
- Out: argument parsing and printing (Task 11).

**Design and invariants**

- `formatBuildId(date)` in `lib/cloudflare/build-id.js` returns
  `YYYY-MM-DDTHH-MM-SSZ` in UTC — for example `2026-08-29T16-49-32Z`. Dashes
  replace the colons of an ISO timestamp so the value is safe in a filename, a
  URL, and a shell argument. It is a pure function of a `Date`, which is what
  makes it testable without a clock.
- `createWorkerVersion(args)` takes one options object:

```js
{
    projectDirectory,
    environment,
    cloudflareConfig,
    apiClient,
    force = false,
    deploy = false,
    bundleModules = defaultBundleModules,
    fileSystem = defaultFileSystem,
    now = () => new Date(),
}
```

  The four defaults mean production callers pass five options and tests pass
  nine. `now` is injected so `BUILD_ID` is assertable.
- It returns a result object rather than printing. Printing is the command's job,
  and a function that returns its outcome is testable:

```js
{
    outcome,          // 'skipped' | 'created' | 'resources-created'
    environment,
    workerName,
    stateFilepath,
    createdResources, // [] unless outcome is 'resources-created'
    changes,          // { modules, bindings, config } booleans
    moduleCount,
    buildId,          // null when not created
    versionId,        // null when not created
    deployed,
    migrations,       // null when none applied
}
```

- Order of operations, and why:
  1. Validate that `environments[environment]` exists, and that
     `WORKER.name` is a non-empty string. A `UsageError` names the dotted path.
     Cheapest possible failure, no network.
  2. `getWorker(WORKER.name)`. A 404 becomes a `UsageError` naming the Worker and
     the `create-worker` invocation. This runs before provisioning so a
     first-time user is not left with orphaned namespaces belonging to a Worker
     that does not exist.
  3. `resolveResources()`. If it created anything, return immediately with
     `outcome: 'resources-created'`. Nothing is bundled, no version is created,
     no state is written.
  4. Read `.env.<environment>` and the state file.
  5. `buildWorkerBindings()`, then `hashValue()` over the result.
  6. `bundleModules({ entryFilepath, externals })` with the entry
     `<projectDirectory>/cloudflare-server.js` and externals
     `[ 'node:', 'cloudflare:' ]`, then `toWorkerModules()` and
     `hashWorkerModules()`.
  7. `hashValue(WORKER_VERSION ?? {})` for the configuration hash.
  8. `planDurableObjectMigrations()`.
  9. Decide. The run proceeds when `force` is true, **or** the state is `null`,
     **or** any of the three hashes differs, **or** the migration plan is
     non-null. The migration condition is essential and easy to miss: a pending
     migration must upload even when all three hashes match, because a migration
     is state that has not yet been applied.
  10. Otherwise return `outcome: 'skipped'`, with `changes` all false.
  11. `buildId = formatBuildId(now())`.
  12. Assemble a `CloudflareWorkerVersion` from the `WORKER_VERSION` block plus
      the generated annotations, add every module with the entry marked `main`,
      add every binding plus the `BUILD_ID` `plain_text` binding, and apply the
      migration operations and `setMigrationTags(oldTag, newTag)` when the plan
      is non-null.
  13. `apiClient.createWorkerVersion(workerName, version.toJSON(), { deploy })`.
  14. Write the state file with the three hashes, the migration tag (the new tag
      when a migration applied, otherwise the recorded one unchanged),
      `nextClasses`, and the version markers.
  15. Return `outcome: 'created'`.
- Annotations are `{ 'workers/tag': buildId, 'workers/triggered_by': 'kixx.js
  cloudflare create-worker-version' }`. No `workers/message`.
- The `WORKER_VERSION` block is spread into the `CloudflareWorkerVersion`
  constructor verbatim. Its validation is that class's job and is not duplicated.
  An absent block means no version-level fields, which is legal.
- **The `old_tag` drift case.** When the upload carries migrations and
  `createWorkerVersion()` rejects in a way indicating a migration tag mismatch,
  catch it and rethrow a `UsageError` explaining that Cloudflare's tag has moved
  past the recorded one — the signature of a crash between a successful upload
  and the state write — and naming the tag to record in the state file by hand.
  Any other failure propagates unchanged. The implementing agent must determine
  the actual shape of that rejection from `CloudflareApiError.status` and
  `errors` and record it in the handoff notes; until then, match conservatively
  and let anything unrecognized propagate.
- The state file is written only after a successful upload. Nothing is written on
  any failure path.
- `changes` reports each hash independently even when several differ, so the
  command can print exactly which ones moved.
- On a first run the state is `null`; `changes` is all true and every hash is
  recorded.

**Expected touch points**

- `lib/cloudflare/build-id.js` — new module.
- `lib/cloudflare/create-worker-version.js` — new module.
- `test/unit-tests/lib/cloudflare/build-id.test.js` — new test file.
- `test/unit-tests/lib/cloudflare/create-worker-version.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `formatBuildId()` returns `YYYY-MM-DDTHH-MM-SSZ` in UTC, zero-padded, for a
      known `Date`.
- [ ] `formatBuildId()` is unaffected by the host time zone.
- [ ] A missing environment block throws a `UsageError` naming the dotted path.
- [ ] A 404 from `getWorker()` throws a `UsageError` naming the Worker and the
      `create-worker` command, before any bundling.
- [ ] A run that creates resources returns `outcome: 'resources-created'` with
      every created resource, and never bundles, uploads, or writes state.
- [ ] A first run with no state file uploads, and `changes` is all true.
- [ ] A second run with unchanged inputs returns `outcome: 'skipped'`, makes no
      `createWorkerVersion()` call, and does not write the state file.
- [ ] A changed module source uploads with `changes.modules` true and the other
      two false.
- [ ] A changed secret value uploads with `changes.bindings` true only.
- [ ] A changed `compatibility_date` uploads with `changes.config` true only.
- [ ] A pending Durable Object migration uploads even when all three hashes
      match.
- [ ] `--force` uploads when nothing changed.
- [ ] `BUILD_ID` appears as a `plain_text` binding in the uploaded payload and is
      absent from the bindings hash input.
- [ ] Two runs whose only difference is the clock produce the same three hashes.
- [ ] Annotations carry `workers/tag` equal to the `BUILD_ID` and
      `workers/triggered_by`, and no `workers/message`.
- [ ] `main_module` is `cloudflare-server.js` and no uploaded module name starts
      with `./`.
- [ ] A version with no migration omits the `migrations` key and leaves
      `migrationTag` unchanged in the written state.
- [ ] A version with a migration sends `old_tag` and `new_tag` and records the
      new tag.
- [ ] `deploy: true` is forwarded to `createWorkerVersion()` and recorded in the
      state.
- [ ] A failed `createWorkerVersion()` writes no state file.
- [ ] A migration-tag rejection is rethrown as a `UsageError` naming the tag to
      record.

**Validation**

- `node run-tests.js test/unit-tests/lib/cloudflare/create-worker-version.test.js`
- `node run-tests.js` — the full suite, proving nothing regressed.
- `node run-linter.js lib commands test`
- Every test injects: a mock `FileSystem` over a file-local map, a mock API
  client recording calls, a stub `bundleModules` returning a two-module bundle
  from a literal, and a fixed `now`. No test patches a module or a global, and no
  test touches the network or a real file.
- A file-local `runCommand(overrides)` helper composing a complete valid
  scenario, with each test overriding only the input it is about. The
  skip-versus-upload matrix is the core of this suite and needs the setup cost to
  be near zero.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 11: CLI command wiring and documentation

**Status:** Not started
**Depends on:** Task 10
**Documentation:** `commands/README.md`, `commands/cloudflare/create-worker.js`, `agents/docs/code-style-guide.md`

**Objective**

`kixx.js cloudflare create-worker-version --environment <env>` exists, lists in
help, validates its arguments, and renders the orchestrator's result as the
progress-and-summary output a person watching a deploy wants to read.

**Scope**

- In: `commands/cloudflare/create-worker-version.js`, the `subcommands` entry in
  `commands/cloudflare/index.js`, and the output rendering.
- Out: every decision the orchestrator makes.

**Scope note on required config**

The runner's `requiredCloudflareConfig` takes static dotted paths, but every path
this command needs is under `environments.<environment>`, which is not known
until `--environment` is parsed. Config validation therefore stays inside the
orchestrator, and `requiredCloudflareConfig` is not declared. Record this in the
handoff notes so a later agent does not add it and wonder why it cannot work.

**Design and invariants**

- The class follows `create-worker.js` exactly: `static description` imported
  from `./index.js`, `static options`, `static requiredSecrets`, a constructor
  taking the injected object, and an `async run(options)` returning an exit code.
- Options: `environment` (string, short `e`), `force` (boolean), `deploy`
  (boolean). `--help` is added by the runner and is not declared.
- `requiredSecrets` is `[ 'cloudflare.accountId', 'cloudflare.apiToken' ]`.
- A missing `--environment` is a `UsageError`, matching `create-worker`.
- `run()` constructs the API client from secrets, calls the orchestrator, renders
  the result, and returns `0`. It contains no branching beyond choosing which
  summary to render for each `outcome`.
- All output goes to `process.stdout`. Rendering is a module-local function per
  outcome, not a chain of conditionals inside `run()`.
- Rendered forms:

```
Environment: production
Worker:      kixx-test-app

Bundled 231 modules
  modules   changed    4f2a1c… -> 8e1190…
  bindings  unchanged
  config    unchanged

BUILD_ID: 2026-08-29T16-49-32Z
Created version a1b2c3d4-…
Not deployed (pass --deploy)
Wrote .kixx/cloudflare-state.production.json
```

```
Environment: production
Worker:      kixx-test-app

Nothing changed since version a1b2c3d4-… (build 2026-08-29T16-49-32Z).
No version created. Pass --force to upload anyway.
```

```
Created 2 resources. Add these IDs to cloudflare-config.js, then re-run:

  environments.production.DOCUMENT_STORE.databaseId
    = "a1b2c3d4-…"
  environments.production.KEY_VALUE_STORE.namespaceId
    = "9f8e7d6c…"

No version was created.
```

- Hashes are abbreviated in output. The full values are in the state file, which
  is the record; a 64-character hex string twice per line is noise.
- The state filepath is printed relative to the project directory.
- Errors are not caught here. `UsageError` prints its message alone and anything
  else prints with a stack trace, which is the runner's existing contract and the
  right behavior for each.

**Expected touch points**

- `commands/cloudflare/create-worker-version.js` — new module.
- `commands/cloudflare/index.js` — new `subcommands` entry.
- `commands/README.md` — only if the static-property contract needs a note about
  environment-scoped config validation.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `node kixx.js cloudflare` lists `create-worker-version` with its
      description.
- [ ] `node kixx.js cloudflare create-worker-version --help` renders the usage
      line, all three options, and the required secrets.
- [ ] A missing `--environment` exits `1` with the `UsageError` message alone and
      no stack trace.
- [ ] The `subcommands` entry and the file basename match.
- [ ] Each of the three outcomes renders its documented form.
- [ ] `run()` returns `0` on every successful outcome, including a skip and a
      resources-created stop.
- [ ] `--deploy` and `--force` reach the orchestrator.

**Validation**

- `node kixx.js` — the `cloudflare` command lists.
- `node kixx.js cloudflare --help` — the sub-command lists.
- `node kixx.js cloudflare create-worker-version --help`
- `node kixx.js cloudflare create-worker-version` — exits `1` naming the missing
  `--environment`.
- `node run-linter.js commands`
- `node run-tests.js` — the full suite.
- No unit tests for the command module itself: it is wiring, and the runner
  constructs it from `argv`. Its behavior is covered by the orchestrator suite
  and by the manual checks above.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task 12: Manual verification against the sample application

**Status:** Not started
**Depends on:** Task 11
**Documentation:** This plan's Implementation Approach; `tmp/app/cloudflare-config.js`

**Objective**

The command is exercised end to end against the real sample application and a
real Cloudflare account, confirming the behaviors that unit tests with injected
mocks cannot: that Cloudflare accepts the module names, the binding set, and the
migration payload this tool produces, and that a second run genuinely skips.

This task produces no automated test. Its output is the recorded observations in
its handoff notes, particularly the two open questions below.

**Scope**

- In: adding `ENVARS` to `tmp/app/cloudflare-config.js`, creating
  `tmp/app/.env.production`, running the command, and recording what happened.
- Out: any committed fixture. `tmp/` is gitignored and `tmp/app` is disposable.

**Design and invariants**

- Prerequisites to set up before running:
  - Add an `ENVARS` block to `environments.production` with `APP_NAME`,
    `ENVIRONMENT`, and `LOG_LEVEL`, matching what `cloudflare-server.js` reads.
  - Create `tmp/app/.env.production` with the three secrets from `example.env`
    and without `APP_NAME`, `ENVIRONMENT`, or `LOG_LEVEL` — those now live in
    `ENVARS`, and leaving them in both must produce the collision `UsageError`,
    which is itself worth confirming once.
  - Ensure `tmp/app/.kixx/` exists so the project directory resolves to
    `tmp/app` rather than the devkit repository.
  - Create the Worker with `kixx.js cloudflare create-worker -e production`.
- Two open questions to answer and record:
  1. **Missing-resource status.** Does verifying a nonexistent KV namespace or D1
     database return HTTP 404, or HTTP 200 with `success: false` and an error
     code? Task 9 assumes 404. If it is a 200 envelope, record the code and
     reopen Task 9.
  2. **Migration tag rejection shape.** What `status` and `errors` does
     Cloudflare return for a stale `old_tag`? Task 10 needs this to recognize the
     drift case. Provoke it by uploading a migration, then hand-editing
     `migrationTag` in the state file back to its previous value and re-running.
- A failure here is a finding, not a defect in this task. Record it, reopen the
  owning task, and fix it there.

**Expected touch points**

- `tmp/app/cloudflare-config.js` — `ENVARS` block.
- `tmp/app/.env.production` — new file.
- Whichever task a discovery reopens.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A run with null resource ids creates the KV namespaces and the D1 database,
      prints their ids with their config key paths, and creates no version.
- [ ] After pasting the ids into the config, a run creates a version and writes
      the state file.
- [ ] The Cloudflare dashboard shows the version with `workers/tag` equal to the
      `BUILD_ID`.
- [ ] The first run's migration creates the `ContentAddressableIndexStore`
      namespace with tag `v1`, and the state records it.
- [ ] An immediate second run prints the nothing-changed summary, creates no
      version, and leaves the state file byte-identical.
- [ ] Editing one source file and re-running uploads with `changes.modules` true
      and the other two false.
- [ ] Editing a secret in `.env.production` and re-running uploads with
      `changes.bindings` true only.
- [ ] Editing `compatibility_date` and re-running uploads with `changes.config`
      true only.
- [ ] `--force` with no change uploads.
- [ ] `--deploy` routes traffic and the deployed Worker responds, with
      `env.BUILD_ID` matching the recorded `buildId`.
- [ ] Declaring the same key in both `ENVARS` and `.env.production` aborts with
      the collision `UsageError`.
- [ ] Both open questions are answered in the handoff notes.

**Validation**

```
cd tmp/app
node ../../kixx.js cloudflare create-worker -e production
node ../../kixx.js cloudflare create-worker-version -e production
node ../../kixx.js cloudflare create-worker-version -e production   # must skip
node ../../kixx.js cloudflare create-worker-version -e production --force
node ../../kixx.js cloudflare create-worker-version -e production --deploy
```

- `git status` in `tmp/app` is not meaningful — `tmp/` is gitignored. Inspect
  `.kixx/cloudflare-state.production.json` directly between runs instead.
- `npm test` in the devkit repository, confirming the linter and the full suite
  still pass after any fix this task provokes.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
