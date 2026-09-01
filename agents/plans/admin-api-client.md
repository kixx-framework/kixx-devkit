Admin API Client Commands
=========================

Add CLI commands implementing a client for the Admin API v1, giving the devkit
the two capabilities it currently lacks: creating a root admin user, and
minting a publishing API token. Also consolidate the per-sub-command
documentation files into one file per top level command.

The API contract is specified in `tmp/admin-api.md`. That document is the
authority for endpoint paths, request and response shapes, error codes, and
operator workflows. Read it before implementing any task that touches the
protocol.


Implementation Approach
-----------------------

### The four operations

The Admin API exposes four endpoints, which become four sub-commands under the
existing `admin` command:

```
kixx.js admin accept-invite            POST /admin-api/v1/users/invite
kixx.js admin create-publishing-token  POST /admin-api/v1/publishing-api-tokens
kixx.js admin list-migrations          GET  /admin-api/v1/migrations
kixx.js admin run-migration <id>       POST /admin-api/v1/migrations/:id/run
```

They live under `admin` because they form one operator story with the existing
`admin gen-secure-token`: generate a bootstrap token, configure it in the
deployment, redeem it to create the root admin, then mint a publishing token
for the `app` commands.

### Credential handling

No admin credential is ever written to a file or passed through argv. Command
line flags appear in shell history and in `ps` output; `.kixx/secrets.json` is
plaintext on disk. An admin password can mint publishing tokens and mutate
production data, so it is treated as more sensitive than the scoped publishing
token that file already holds.

Credentials are prompted interactively, with the password echo suppressed.
Environment variables skip the corresponding prompt so the commands remain
usable from a script:

- `KIXX_ADMIN_EMAIL`
- `KIXX_ADMIN_PASSWORD`
- `KIXX_ADMIN_INVITE_TOKEN`

When a value is absent and stdin is not a TTY, the command fails immediately
with a `UsageError` naming the environment variable. It must never block on a
closed or non-interactive stdin.

### Origin resolution

The origin comes from `--environment`, resolving `app.environments.<env>.origin`
in `.kixx/config.json`, overridable with `--origin`. This is the same lookup the
`app` commands already perform, so an operator uses one spelling of "which
deployment" across the whole CLI.

Because a real migration batch mutates durable state, `run-migration` echoes the
resolved environment name and origin to stdout before issuing a real (non
dry-run) request. This is a visibility measure against a stale `--environment`
value, not a confirmation prompt.

### Retry policy

The Admin API client retries more conservatively than the Publishing API client.
`POST /admin-api/v1/migrations/:id/run` mutates durable ledger state, and while
the specification requires migration implementations to be idempotent, the
client should not rely on that to paper over its own retries.

- Read requests (GET): retry on 429 and 5xx.
- Write requests (POST): retry on 429 only.

Network-level failures follow the same split: retried for reads, surfaced
immediately for writes.

### Considered and deferred

Two pieces of work were considered during planning and deliberately left out.
They are recorded here so a later agent finds the reasoning rather than
rediscovering it, and does not file either as a defect.

**A shared JSON:API transport.** `lib/publishing/publishing-api-client.js`
contains roughly 150 lines of generic plumbing — the retry loop with jitter,
token redaction, JSON parsing, JSON:API error formatting, and the code-to-class
error factory. The Admin API client duplicates that rather than extracting a
shared module. The publishing client is working, tested code on the release
path, and refactoring it is scope unrelated to this feature. The two clients
also differ in ways that would push configuration into a shared transport: auth
scheme varies per endpoint in the Admin API, and the retry policies differ as
described above. Revisit the extraction after the admin client exists, so the
refactor is validated against two real callers instead of one imagined one. The
duplication is known and intentional.

**A `.kixx/secrets.json` writer.** `create-publishing-token` prints the one-time
plaintext token and writes it nowhere; the operator copies it into
`app.environments.<env>.publishingToken` by hand. A `--save` flag was considered
and deferred. Nothing in the CLI writes `secrets.json` today — `config-loader.js`
reads and deep-freezes both layers — so this would be the first writer, and a
read-modify-write of a hand-maintained JSON file has to pick the right layer,
preserve unrelated keys, avoid clobbering a concurrent edit, and decide what to
do when the key already holds a working token. The plaintext token is
unrecoverable, so a bug in that path costs the operator the token. If it is
built later, it belongs in its own task with its own tests, not as a rider on
the token command.

### Cross-cutting constraints

- Every command module stays thin wiring: parse arguments, resolve settings,
  make one library call, render the result. Protocol and decision logic belong
  in `lib/`.
- Commands accept their collaborators through the constructor argument object
  so unit tests can inject them, matching `commands/app/rollback.js`.
- Secrets are redacted from every error message and every rendered error object
  before it reaches stdout or stderr.
- Output is human-rendered text. No command gains a `--json` flag; no command in
  this CLI has one.
- Run `npm run lint` and `node run-tests.js` for every task touching JavaScript.


### Task dependency graph

```
Task 1 (prompt helper) ─┐
Task 2 (API client) ────┼─> Task 4 (invite, token commands)
Task 3 (origin resolve) ┴─> Task 5 (migration commands)

Task 6 (docs) — independent
```

Task 6 depends on nothing and may land before or after the rest, except that its
`docs/admin.md` content describes the commands built in tasks 4 and 5.


---

### Task 1: Interactive credential prompts with a non-interactive bypass

**Status:** Complete
**Depends on:** None
**Documentation:** None

**Objective**

A reusable module reads a credential from the operator's terminal, suppressing
echo for secret values, and yields to an environment variable when one is set.
When neither an environment variable nor an interactive terminal is available,
it fails with a clear `UsageError` instead of blocking. Every admin command
acquires its credentials through this module.

**Scope**

- In: `lib/prompt.js`; terminal reading, echo suppression, environment variable
  bypass, TTY detection, and the double-entry password comparison helper.
- Out: Any knowledge of admin credentials specifically, of the Admin API, or of
  which environment variable names a given command uses. Callers pass those in.

**Design and invariants**

- Nothing in the codebase reads stdin today. This module is the only place that
  does.
- Input and output streams are injected, defaulting to `process.stdin` and
  `process.stdout`, so tests never touch a real TTY.
- Echo suppression is achieved by writing nothing back for masked input. Use
  `node:readline` and suppress output on the interface's output stream rather
  than toggling raw mode by hand.
- The environment variable is checked before the terminal is touched. A set but
  empty variable is treated as absent, not as an empty credential.
- TTY detection reads the injected input stream's `isTTY`, never
  `process.stdin.isTTY` directly, so tests can exercise both branches.
- The `UsageError` for a non-interactive context must name the environment
  variable the caller can set. A message that only says "not a terminal" leaves
  the operator with no next action.
- The prompt never echoes, logs, or includes a secret value in any error.
- A cancelled prompt (EOF, Ctrl-C) resolves to a `UsageError`, not a hang and
  not an empty string.

**Expected touch points**

- `lib/prompt.js` — the module
- `test/unit-tests/lib/prompt.test.js` — its tests

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A visible prompt reads a line from the injected input stream and returns it trimmed.
- [ ] A masked prompt reads a line without writing the typed characters to the output stream.
- [ ] A set environment variable returns its value without reading the input stream at all.
- [ ] An empty or whitespace-only environment variable is treated as absent.
- [ ] A non-TTY input stream with no environment variable throws a `UsageError` naming that variable.
- [ ] A double-entry helper prompts twice and throws a `UsageError` when the two values differ, without revealing either.
- [ ] EOF on the input stream produces a `UsageError` rather than hanging or returning an empty value.
- [ ] JSDoc block comments per `agents/docs/code-documentation-guide.md`.

**Validation**

- `node run-tests.js test/unit-tests/lib/prompt.test.js` — all behaviors above
- `npm run lint` — no new violations
- Manual: a throwaway script calling the masked prompt in a real terminal shows no echoed characters.

**Progress and handoff**

- Completed: `lib/prompt.js` implemented with `promptForValue()` and
  `promptForValueTwice()`; full test coverage; lint clean.
- Current state: Complete. All acceptance criteria met.
- Remaining: Nothing.
- Decisions and discoveries:
  - Named the exports `promptForValue()` / `promptForValueTwice()` rather than
    anything credential-specific, per the "no knowledge of admin credentials"
    scope note. Callers pass `envVar` and `label`.
  - Masking is implemented by forcing `terminal: true` on the `readline`
    interface and overriding the undocumented `rl._writeToOutput` hook to a
    no-op — the standard workaround, since `readline` has no public silent-echo
    option. Not toggling raw mode by hand, per the design note.
  - In the `line` handler, `resolve()` must be called before `rl.close()`.
    `close()` emits `'close'` synchronously, which the same handler treats as
    cancellation; resolving first makes that later rejection a harmless no-op
    on an already-settled promise. Got this backwards initially and the tests
    caught it immediately (UsageError instead of the typed value).
  - Tests fake a TTY with `node:stream` `PassThrough` pairs, setting
    `.isTTY = true/false` manually on the input side, per the design note that
    the module must read the injected stream's `isTTY` rather than
    `process.stdin.isTTY`. `PassThrough` lacks `setRawMode`, which `readline`
    tolerates by silently skipping raw-mode setup.
- Actual files changed:
  - `lib/prompt.js` (new)
  - `test/unit-tests/lib/prompt.test.js` (new)
- Validation run:
  - `node run-tests.js test/unit-tests/lib/prompt.test.js` — 8/8 passed
  - `node run-tests.js` (full suite) — 387/387 passed
  - `npm run lint` — clean
  - Manual real-terminal check of the masked prompt was not performed in this
    session (no interactive TTY available to the executor); the automated
    fake-TTY tests exercise the same code path forced via `terminal: true`.
- Blockers: None.


---

### Task 2: Admin API client and typed protocol errors

**Status:** Complete
**Depends on:** None
**Documentation:** `tmp/admin-api.md` — all sections

**Objective**

A client class sends requests to all four Admin API v1 endpoints, applying the
correct authentication scheme per endpoint, and converts failure responses into
typed errors carrying the recovery action the operator needs. No command code
constructs an Admin API request directly.

**Scope**

- In: `lib/admin/admin-api-client.js`, `lib/admin/admin-api-error.js`; the four
  endpoint methods, per-endpoint authentication, the retry policy, secret
  redaction, and the code-to-error-class mapping.
- Out: Credential acquisition (Task 1), origin resolution (Task 3), and all
  rendering of results for the operator (Tasks 4 and 5).

**Design and invariants**

- Structure mirrors `lib/publishing/publishing-api-client.js`: a class with
  private fields, injected `fetch`, `wait`, and `random`, one private
  `#request` method, and module-scoped helper functions below the class.
- The duplication of transport plumbing with the publishing client is
  intentional. See "Considered and deferred" in the Implementation Approach.
- Authentication varies per endpoint. Three endpoints send HTTP Basic built from
  an email and password; `POST /users/invite` sends `Bearer <invite-token>` and
  must never send Basic credentials. Model this so a caller cannot accidentally
  send the wrong scheme — the invite call should not be able to reach the Basic
  code path.
- Base URL is `/admin-api/v1/` resolved against the configured origin.
- Every `POST` sends `Content-Type: application/vnd.api+json` and a JSON:API
  resource document with the resource type the specification requires:
  `MigrationRun`, `AdminUser`, `PublishingApiToken`.
- Retry policy: reads retry on 429 and 5xx; writes retry on 429 only. Network
  failures retry for reads and surface immediately for writes.
- Redaction covers the password, the invite token, and the minted publishing
  token. Redact before any message or error object is constructed, not at the
  point of printing. The password and invite token must never appear in a
  message, an error property, or a stack trace.
- Five typed subclasses of `AdminApiError`, selected by response error code,
  because each implies a different operator action:
  `MigrationAlreadyAppliedError`, `MigrationCursorConflictError`,
  `MigrationConcurrencyError`, `InvalidCredentialsError`, `InvalidInviteError`.
  Every other code produces the base `AdminApiError` rendering the response's
  error objects verbatim. Adding subclasses for codes nobody catches is
  deliberately avoided.
- `MigrationCursorConflictError` and `MigrationConcurrencyError` must not be
  conflated. The first requires restarting with `force`, the second requires
  reloading status and retrying without force. Confusing them is expensive.
- Response parsing asserts the JSON:API envelope shape before reading it, so a
  malformed response fails with a protocol error rather than a `TypeError`.

**Expected touch points**

- `lib/admin/admin-api-client.js` — client class
- `lib/admin/admin-api-error.js` — base error, five subclasses, factory
- `test/unit-tests/lib/admin/admin-api-client.test.js` — client tests
- `test/unit-tests/lib/admin/admin-api-error.test.js` — error mapping tests

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `listMigrations()` issues `GET /admin-api/v1/migrations` with Basic auth and returns the migration records with their attributes.
- [ ] `runMigration(id, options)` issues `POST /admin-api/v1/migrations/:id/run` with a `MigrationRun` document, sending only the attributes the caller supplied, and returns `done`, `cursor`, `stats`, `status`, and `dryRun`.
- [ ] `runMigration()` rejects a call passing both `dryRun` and `force` before issuing a request.
- [ ] `acceptInvite()` issues `POST /admin-api/v1/users/invite` with a Bearer invite token and an `AdminUser` document, and sends no Basic credentials.
- [ ] `createPublishingApiToken()` issues `POST /admin-api/v1/publishing-api-tokens` with a `PublishingApiToken` document and returns the one-time plaintext token with its metadata.
- [ ] The migration id is URL-encoded in the request path.
- [ ] Each of the five mapped error codes produces its specific error class; an unmapped code produces the base class.
- [ ] A read request retries on 429 and on 5xx; a write request retries on 429 and not on 5xx.
- [ ] A password, invite token, and minted token are absent from every error message and error property when the server echoes them back.
- [ ] A malformed or non-JSON response body produces an `AdminApiError`, not a runtime type error.
- [ ] JSDoc block comments per `agents/docs/code-documentation-guide.md`.

**Validation**

- `node run-tests.js test/unit-tests/lib/admin` — all behaviors above, using an injected `fetch` stub
- `npm run lint` — no new violations
- Tests must cover the retry split explicitly by asserting the number of `fetch` calls for a 5xx read versus a 5xx write.

**Progress and handoff**

- Completed: `lib/admin/admin-api-client.js` and `lib/admin/admin-api-error.js`
  implemented with full test coverage; lint clean.
- Current state: Complete. All acceptance criteria met.
- Remaining: Nothing.
- Decisions and discoveries:
  - API error codes are inconsistent in casing: the three migration conflict
    codes are the full class names (`MigrationAlreadyAppliedError`,
    `MigrationCursorConflictError`, `MigrationConcurrencyError`), but the auth
    failures are shortened (`InvalidCredentials`, `InvalidInvite`, without the
    `Error` suffix). Confirmed by grepping `tmp/admin-api.md` directly rather
    than assuming a uniform pattern like the publishing API's error codes.
    `ERROR_CLASSES` in `lib/admin/admin-api-error.js` maps both forms.
  - Auth scheme is modeled by having `#request()` accept an `authorization`
    option that defaults (via a lazy default-parameter expression) to
    `#basicAuthorization()`. `acceptInvite()` always passes its own `Bearer`
    value explicitly, so the Basic code path is structurally unreachable from
    that method — satisfies "the invite call should not be able to reach the
    Basic code path" without a second client class or a flag.
  - Retry policy is centralized in one `#isRetryable(status, isWrite)` check
    (429 always retryable; 5xx only when `!isWrite`) and one `catch` branch
    keyed on `isWrite`, rather than duplicating the loop per verb.
  - Considered giving `createPublishingApiToken()` a private field to redact
    the freshly minted token from any later error in the same client instance,
    but removed it: the token cannot appear in a response earlier than the one
    that mints it, so there was nothing for that redaction to protect against.
    Redaction of the minted token is exercised for the response that returns
    it (never an error case for that call); password and invite-token
    redaction on error responses are covered directly.
  - Redaction happens per-request: `#request()` builds `secrets` from
    `this.#password` plus any `redact` list the caller supplies (`acceptInvite`
    passes the invite token and the new password), and both the message and
    the structured `errors` array are redacted before `createAdminApiError()`
    constructs the typed error — never after.
- Actual files changed:
  - `lib/admin/admin-api-client.js` (new)
  - `lib/admin/admin-api-error.js` (new)
  - `test/unit-tests/lib/admin/admin-api-client.test.js` (new)
  - `test/unit-tests/lib/admin/admin-api-error.test.js` (new)
- Validation run:
  - `node run-tests.js test/unit-tests/lib/admin` — 17/17 passed
  - `node run-tests.js` (full suite) — 404/404 passed
  - `npm run lint` — clean
- Blockers: None.


---

### Task 3: Shared environment origin resolution

**Status:** Complete
**Depends on:** Task 2
**Documentation:** None

**Objective**

The origin lookup that turns `--environment` into a configured origin is owned
by one function used by both the publishing and admin subsystems, so both
report a missing setting with the same message naming the same file and key
path. The `app` commands continue to behave exactly as they do now.

**Scope**

- In: Extracting the origin resolution from
  `lib/publishing/resolve-publishing-environment.js` into a shared helper;
  adding `lib/admin/resolve-admin-environment.js` which uses it to construct an
  `AdminAPIClient`.
- Out: Credential resolution, which belongs to Task 1 and to the command
  modules. This task resolves the origin and builds the client; it does not
  prompt.

**Design and invariants**

- This task modifies code the `app` commands depend on. Their existing tests are
  part of this task's validation, not an afterthought.
- The extracted helper keeps the current behavior exactly: an explicit override
  wins; a non-empty configured value is next; anything else throws a
  `UsageError` naming the key path and the file. A supplied but empty override
  is an error, not a fallthrough.
- Error message text for the origin does not change. Operators and the existing
  tests depend on it.
- `resolveAdminEnvironment()` returns the environment name, the origin, and a
  client, mirroring `resolvePublishingEnvironment()`'s shape. It accepts an
  injectable `createClient` factory for tests.
- Admin credentials are passed in by the caller rather than resolved here, which
  keeps this module free of terminal I/O and keeps it synchronous.
- Do not generalize beyond the two known callers. The shared piece is the origin
  lookup only; the token lookup stays in the publishing resolver.

**Expected touch points**

- `lib/publishing/resolve-publishing-environment.js` — use the extracted helper
- `lib/admin/resolve-admin-environment.js` — new admin resolver
- a new or existing shared module holding the extracted setting resolution
- `test/unit-tests/lib/admin/resolve-admin-environment.test.js` — new tests
- `test/unit-tests/commands/app/environment-errors.test.js` — must still pass unchanged

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `resolveAdminEnvironment()` resolves the origin from `app.environments.<env>.origin` and returns an Admin API client.
- [ ] An `--origin` override takes precedence over the configured value.
- [ ] An empty `--origin` override throws a `UsageError` rather than falling through to config.
- [ ] A missing origin throws a `UsageError` naming `app.environments.<env>.origin` and `.kixx/config.json`.
- [ ] A missing `--environment` throws a `UsageError`.
- [ ] `resolvePublishingEnvironment()` produces byte-identical error messages to those it produces today.
- [ ] All existing `app` command and publishing tests pass without modification.
- [ ] JSDoc block comments per `agents/docs/code-documentation-guide.md`.

**Validation**

- `node run-tests.js test/unit-tests/lib/admin/resolve-admin-environment.test.js` — new behavior
- `node run-tests.js test/unit-tests/commands/app test/unit-tests/lib/publishing` — proves the extraction did not change `app` behavior
- `node run-tests.js` — full suite
- `npm run lint` — no new violations

**Progress and handoff**

- Completed: Extracted `resolveEnvironmentOrigin()` into
  `lib/resolve-environment-origin.js`; `resolvePublishingEnvironment()` now
  calls it for origin resolution and keeps its own `resolveSetting()` helper
  only for the token lookup; added `lib/admin/resolve-admin-environment.js`.
  Full test coverage added; lint clean.
- Current state: Complete. All acceptance criteria met.
- Remaining: Nothing.
- Decisions and discoveries:
  - Put the shared helper at `lib/resolve-environment-origin.js` (not inside
    `lib/publishing/` or `lib/admin/`) since it is owned by neither subsystem.
  - Preserved exact error message text by copying the three message templates
    verbatim from the original `resolveSetting()` origin branch — confirmed
    byte-identical via the new `resolve-environment-origin.test.js` and by
    rerunning the untouched `environment-errors.test.js` and the rest of the
    `app`/`publishing` suites.
  - `resolvePublishingEnvironment()` deliberately still resolves `origin`
    before `token`, so a missing `--environment` throws from the origin helper
    before the token lookup ever runs (which would otherwise build a
    key path like `app.environments.undefined.publishingToken`).
  - `resolveAdminEnvironment()` takes `email`/`password` as plain arguments and
    forwards them straight to `createClient()`; it does no prompting and stays
    synchronous, per the scope note keeping Task 1's terminal I/O out of this
    module.
- Actual files changed:
  - `lib/resolve-environment-origin.js` (new)
  - `lib/admin/resolve-admin-environment.js` (new)
  - `lib/publishing/resolve-publishing-environment.js` (modified: origin
    resolution delegates to the shared helper)
  - `test/unit-tests/lib/resolve-environment-origin.test.js` (new)
  - `test/unit-tests/lib/admin/resolve-admin-environment.test.js` (new)
- Validation run:
  - `node run-tests.js test/unit-tests/lib/admin/resolve-admin-environment.test.js test/unit-tests/lib/resolve-environment-origin.test.js` — 9/9 passed
  - `node run-tests.js test/unit-tests/commands/app test/unit-tests/lib/publishing` — 75/75 passed, unchanged
  - `node run-tests.js` (full suite) — 413/413 passed
  - `npm run lint` — clean
- Blockers: None.


---

### Task 4: Bootstrap commands — accept-invite and create-publishing-token

**Status:** Complete
**Depends on:** Tasks 1, 2, 3
**Documentation:** `tmp/admin-api.md` — "Accept an admin invite", "Create a publishing API token", "Bootstrap the first admin", "Mint a publishing credential"

**Objective**

An operator can create the first root admin account by redeeming a bootstrap or
invite token, and can then mint a publishing API token for use by the `app`
commands. These two commands close the gap named in the request: the devkit can
now create a root admin and obtain a publishing token.

**Scope**

- In: `commands/admin/accept-invite.js`,
  `commands/admin/create-publishing-token.js`, their entries in
  `commands/admin/index.js`, and their rendering of results.
- Out: The migration commands (Task 5). Writing the minted token into
  `.kixx/secrets.json` — see "Considered and deferred".

**Design and invariants**

- These two commands are paired because `accept-invite` is the only endpoint
  using Bearer invite authentication rather than Basic, and
  `create-publishing-token` is the operation that immediately follows it in the
  bootstrap sequence.
- `accept-invite` acquires three values through Task 1's module: the invite
  token (`KIXX_ADMIN_INVITE_TOKEN`), the new account email (`KIXX_ADMIN_EMAIL`),
  and the new account password (`KIXX_ADMIN_PASSWORD`).
- The new password is entered twice and compared before any request is sent. A
  typo creates an account nobody can log into and consumes a single-use invite.
- The 16 to 256 character length is checked locally before sending. A `422` does
  not consume the invite, but there is no reason to make the operator discover
  that by failing.
- `create-publishing-token` acquires the admin email and password through
  Task 1's module and offers `--roles`, `--ttl`, and `--description`, all
  optional, matching the API defaults (`["editor"]`, 2592000 seconds).
- The minted plaintext token is printed in a clearly labeled block stating that
  it appears once and cannot be retrieved, and naming
  `app.environments.<env>.publishingToken` in `.kixx/secrets.json` as its
  destination. It is written to no file.
- Command modules stay thin. Validation that belongs to the protocol lives in
  the client; only argument-shaped validation lives here, raised as
  `UsageError`.
- Collaborators — the client factory and the prompt module — are injected
  through the constructor argument object so tests need no terminal and no
  network.
- Both commands return 0 on success. A `UsageError` prints its message alone;
  every other error prints in full.

**Expected touch points**

- `commands/admin/accept-invite.js` — invite redemption command
- `commands/admin/create-publishing-token.js` — token minting command
- `commands/admin/index.js` — two new `subcommands` entries
- `test/unit-tests/commands/admin/accept-invite.test.js`
- `test/unit-tests/commands/admin/create-publishing-token.test.js`

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `kixx.js admin accept-invite -e <env>` prompts for invite token, email, and password, and creates the account.
- [ ] The password is prompted twice; mismatched entries fail with a `UsageError` before any request is sent, revealing neither value.
- [ ] A password shorter than 16 or longer than 256 characters fails locally with a `UsageError` before any request is sent.
- [ ] A successful redemption prints the created account's id, email address, and creation date, and never the password.
- [ ] An `InvalidInviteError` renders operator-facing guidance that the token is unknown, expired, revoked, or already used.
- [ ] `kixx.js admin create-publishing-token -e <env>` prompts for admin credentials and prints the one-time plaintext token, its roles, description, and expiration date.
- [ ] The printed token block states that the value appears once and names its destination in `.kixx/secrets.json`.
- [ ] `--roles`, `--ttl`, and `--description` are optional and are omitted from the request when not supplied.
- [ ] Both commands appear in `kixx.js admin --help` with descriptions imported from `index.js`.
- [ ] Both commands fail with a `UsageError` naming the environment variable when stdin is not a TTY and no variable is set.
- [ ] JSDoc block comments per `agents/docs/code-documentation-guide.md`.

**Validation**

- `node run-tests.js test/unit-tests/commands/admin` — both commands, with injected client and prompt
- `node kixx.js admin --help` — both sub-commands list with descriptions
- `node kixx.js admin accept-invite --help` and `node kixx.js admin create-publishing-token --help` — usage renders
- `npm run lint` — no new violations
- Manual: run both against a local development server at `http://localhost:2026`, redeeming a real bootstrap token and minting a real publishing token.

**Progress and handoff**

- Completed: `commands/admin/accept-invite.js`, `commands/admin/create-publishing-token.js`,
  their `commands/admin/index.js` entries, and their tests. Lint clean, full
  suite green.
- Current state: Complete except the manual against-a-real-server check
  (documented exception below).
- Remaining: Nothing automatable. Manual verification against a running
  `http://localhost:2026` Admin API was not performed this session — no local
  dev server was started. A later session (or the user) should run
  `node kixx.js admin accept-invite -e <env>` and
  `node kixx.js admin create-publishing-token -e <env>` against a real
  deployment before treating the bootstrap flow as field-verified.
- Decisions and discoveries:
  - Both commands inject `promptForValue`/`promptForValueTwice` and
    `resolveAdminEnvironment` through the constructor args object (mirroring
    `assignRelease` injection in `commands/app/rollback.js`), so unit tests
    supply canned answers and a fake client with no terminal and no network.
  - The "fails with UsageError naming the env var when stdin is not a TTY"
    criterion needs no special test wiring: the test runner's own `stdin` is
    not a TTY, so constructing the command with only `config` (no injected
    prompt) and calling `run()` exercises the real `promptForValue()` and
    hits that branch directly.
  - `accept-invite` catches `InvalidInviteError` at the command layer and
    re-throws a `UsageError` with the operator-facing guidance sentence, so
    the runner prints only that sentence (per `commands/README.md`'s
    UsageError-prints-message-alone contract) rather than the raw protocol
    error.
  - `create-publishing-token` does not special-case `InvalidCredentialsError`
    — not required by this task's acceptance criteria — so it prints in full
    via the runner's generic error path.
  - `--roles` uses `{ type: 'string', multiple: true }` so `options.roles` is
    `undefined` when omitted (matches "omitted from the request when not
    supplied") rather than defaulting to an empty array.
- Actual files changed:
  - `commands/admin/accept-invite.js` (new)
  - `commands/admin/create-publishing-token.js` (new)
  - `commands/admin/index.js` (modified: two new `subcommands` entries)
  - `test/unit-tests/commands/admin/accept-invite.test.js` (new)
  - `test/unit-tests/commands/admin/create-publishing-token.test.js` (new)
- Validation run:
  - `node run-tests.js test/unit-tests/commands/admin` — 7/7 passed
  - `node run-tests.js` (full suite) — 420/420 passed
  - `npm run lint` — clean
  - `node kixx.js admin --help` — both sub-commands listed
  - `node kixx.js admin accept-invite --help` / `create-publishing-token --help` — usage renders
  - Manual against a real server — not run (see Remaining above)
- Blockers: None.


---

### Task 5: Migration commands — list-migrations and run-migration

**Status:** Complete
**Depends on:** Tasks 1, 2, 3
**Documentation:** `tmp/admin-api.md` — "List migrations", "Run a migration batch", "Safely apply a migration"

**Objective**

An operator can see every registered migration with its durable status, and can
drive a migration forward one bounded batch at a time, in either dry-run or real
mode, with the information needed to decide whether to issue the next batch.

**Scope**

- In: `commands/admin/list-migrations.js`, `commands/admin/run-migration.js`,
  their entries in `commands/admin/index.js`, and the migration status rendering
  they share.
- Out: Any loop that issues batches automatically. One invocation sends exactly
  one batch.

**Design and invariants**

- These two commands are paired because they share migration status rendering
  and both use Basic authentication.
- **One batch per invocation.** The operator owns the loop. `run-migration`
  prints the returned cursor and whether the run is done, so the operator can
  decide to issue the next batch.
- `run-migration` takes the migration id as a required positional and offers
  `--dry-run`, `--force`, `--cursor`, and `--yes`.
- `--dry-run` and `--force` are mutually exclusive; passing both is a
  `UsageError` raised before any request.
- `--cursor` is meaningful only for a dry run. The specification states the
  server owns real-run progress and ignores a submitted cursor; passing
  `--cursor` without `--dry-run` is a `UsageError` rather than a silently
  ignored argument.
- **`--force` requires confirmation.** It is the only operation here that
  destroys information the server cannot reconstruct — it resets the cursor,
  accumulated stats, batch count, start identity, and timestamps of an applied
  or failed run. Require a typed confirmation naming the migration id and the
  environment. `--yes` bypasses it for scripted use. Nothing else in these
  commands prompts for confirmation; a prompt on every batch would train the
  operator to click through it.
- **Real runs echo their target.** Before issuing a real (non dry-run) batch,
  print the resolved environment name and origin. This guards against a stale
  `--environment` value carried over from a previous command. Dry runs do not
  need it.
- After a batch, print `done`, `status`, `stats`, and the cursor. When not done,
  state the exact next invocation the operator should run — including the
  cursor for a dry run.
- The three migration conflict errors get distinct guidance, because their
  correct next actions differ and are easy to confuse:
  `MigrationAlreadyAppliedError` suggests `--force` to rerun deliberately;
  `MigrationCursorConflictError` states the ledger has failed and requires
  `--force` to restart; `MigrationConcurrencyError` states another operator
  advanced the migration and to re-run `list-migrations` and retry *without*
  force.
- `list-migrations` renders the registry in order. The eight migration
  attributes do not all fit a terminal width; choose the column layout during
  implementation, prioritizing id, status, and description, and surface `error`
  for a failed migration.
- Collaborators are injected through the constructor argument object.

**Expected touch points**

- `commands/admin/list-migrations.js` — listing command
- `commands/admin/run-migration.js` — batch command
- `commands/admin/index.js` — two new `subcommands` entries
- a shared rendering helper for migration status, in `lib/admin/` if it grows beyond trivial
- `test/unit-tests/commands/admin/list-migrations.test.js`
- `test/unit-tests/commands/admin/run-migration.test.js`

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `kixx.js admin list-migrations -e <env>` prints every registered migration in registry order with its id, status, and description.
- [ ] A failed migration's `error` message is visible in the listing.
- [ ] A `pending` migration renders its null fields without printing `null` noise.
- [ ] `kixx.js admin run-migration -e <env> <id>` sends exactly one real batch and prints `done`, `status`, `stats`, and the cursor.
- [ ] A real run prints the resolved environment name and origin before issuing the request.
- [ ] A dry run does not print the target echo and does send `dryRun: true`.
- [ ] `--dry-run` with `--force` fails with a `UsageError` before any request.
- [ ] `--cursor` without `--dry-run` fails with a `UsageError` before any request.
- [ ] `--force` prompts for a typed confirmation naming the migration id and environment, and aborts with a non-zero exit when declined.
- [ ] `--force --yes` proceeds without prompting.
- [ ] When `done` is false, the output states the next invocation to run, including the cursor for a dry run.
- [ ] Each of the three migration conflict errors renders its own distinct recovery guidance.
- [ ] An unregistered migration id renders the API's 404 as an operator-facing message.
- [ ] Both commands appear in `kixx.js admin --help` with descriptions imported from `index.js`.
- [ ] JSDoc block comments per `agents/docs/code-documentation-guide.md`.

**Validation**

- `node run-tests.js test/unit-tests/commands/admin` — both commands, with injected client and prompt
- `node kixx.js admin list-migrations --help` and `node kixx.js admin run-migration --help` — usage renders
- `npm run lint` — no new violations
- Manual: against a local development server, list migrations, run dry-run batches carrying the cursor forward until done, then run real batches until done, and confirm `list-migrations` reports `applied` with accumulated stats.

**Progress and handoff**

- Completed: `commands/admin/list-migrations.js`, `commands/admin/run-migration.js`,
  their `commands/admin/index.js` entries, and their tests. Also added
  `promptForConfirmation()` to `lib/prompt.js` (see discovery below) with its
  own tests. Lint clean, full suite green.
- Current state: Complete except the manual against-a-real-server check
  (documented exception below).
- Remaining: Manual verification against a running `http://localhost:2026`
  Admin API — listing migrations, driving dry-run batches to completion,
  driving real batches to completion, and confirming `list-migrations` then
  reports `applied` — was not performed this session; no local dev server was
  available to the executor.
- Decisions and discoveries:
  - `--force` needs a typed confirmation that is not a credential and has no
    environment-variable bypass (`--yes` is the bypass). Rather than bolt this
    onto `promptForValue()`, added a new `promptForConfirmation(label,
    expected)` export to `lib/prompt.js`: no `envVar`, TTY-gated, compares the
    typed line to an exact expected string. This slightly extends Task 1's
    module after that task was already marked complete; Task 1's existing
    exports and tests are untouched, and the new function has its own tests in
    `test/unit-tests/lib/prompt.test.js`, all still green.
  - `run-migration` validates `--dry-run`/`--force` mutual exclusion and the
    `--cursor`-requires-`--dry-run` rule, prompts for admin credentials,
    resolves the connection, prompts for `--force` confirmation (skippable
    with `--yes`), echoes environment/origin only for a real run, issues
    exactly one batch, and renders the result — in that order, matching the
    plan's ordering rationale (fail fast on argument shape before touching the
    terminal for credentials or network).
  - The three migration conflict errors get distinct `UsageError` guidance in
    a small `runBatch()` wrapper in `commands/admin/run-migration.js`, keeping
    the `instanceof` checks in one place rather than scattered through `run()`.
  - `list-migrations` renders only `id`, `status`, `description`, plus `error`
    for a failed migration — the plan's own priority list — so a `pending`
    migration's null `stats`/`batchCount`/etc. are never touched and never
    printed, satisfying "no null noise" without special-casing nulls.
  - No shared rendering module was created under `lib/admin/`: the
    list-migrations table and the single-migration batch-result rendering
    don't overlap enough to justify one, per the plan's "if it grows beyond
    trivial" qualifier.
- Actual files changed:
  - `commands/admin/list-migrations.js` (new)
  - `commands/admin/run-migration.js` (new)
  - `commands/admin/index.js` (modified: two new `subcommands` entries)
  - `lib/prompt.js` (modified: added `promptForConfirmation()`)
  - `test/unit-tests/commands/admin/list-migrations.test.js` (new)
  - `test/unit-tests/commands/admin/run-migration.test.js` (new)
  - `test/unit-tests/lib/prompt.test.js` (modified: added confirmation tests)
- Validation run:
  - `node run-tests.js test/unit-tests/commands/admin` — 18/18 passed
  - `node run-tests.js test/unit-tests/lib/prompt.test.js` — 11/11 passed
  - `node run-tests.js` (full suite) — 434/434 passed
  - `npm run lint` — clean
  - `node kixx.js admin --help`, `run-migration --help`, `list-migrations --help` — all render
  - Manual against a real server — not run (see Remaining above)
- Blockers: None.


---

### Task 6: Consolidate documentation by top level command

**Status:** Complete
**Depends on:** None
**Documentation:** existing files under `docs/`

**Objective**

Documentation is organized by top level command rather than by sub-command, and
the environment settings material currently repeated across five files is stated
once. An operator reading `docs/admin.md` finds the bootstrap sequence as a
narrative rather than as four disconnected files.

**Scope**

- In: Replacing the eight per-sub-command files with `docs/app.md`,
  `docs/cloudflare.md`, and `docs/admin.md`; extracting shared settings material
  into `docs/configuration.md`; updating the `README.md` link list.
- Out: Changing any documented behavior. This task moves and deduplicates prose;
  it does not revise what the commands do.

**Design and invariants**

- The eight existing files are deleted, not left as stubs. This is a local
  devkit with no external inbound links, and stub files would be permanent
  clutter.
- Each new file uses one section per sub-command, preserving the existing
  content. Do not summarize away detail during the move.
- `docs/configuration.md` holds the material currently restated in five files:
  the `.kixx` two-layer merge, `--environment`, `app.environments.<env>.origin`,
  `app.environments.<env>.publishingToken`, and the Cloudflare settings. The
  three command files link to it rather than repeating it. This duplication is
  tolerable when scattered across eight files but reads badly once two files
  each contain it several times over.
- `docs/admin.md` is written as the bootstrap narrative, in order: generate a
  token with `gen-secure-token`, configure it as `ADMIN_BOOTSTRAP_TOKEN` in the
  deployment, redeem it with `accept-invite`, mint a credential with
  `create-publishing-token`, store it in `.kixx/secrets.json`, then remove the
  bootstrap token from the deployment. State that the bootstrap token is
  single-use and that its consumption is recorded even while the environment
  value remains configured.
- `docs/admin.md` documents `gen-secure-token`, which has no documentation
  today.
- `docs/admin.md` states the credential rules once: prompts by default, the
  three environment variables for non-interactive use, and that no admin
  credential is stored in `.kixx/secrets.json`.
- Migration documentation must state that one invocation runs one batch and that
  the operator repeats until done, and must distinguish when to use `--force`
  from when not to.
- The README's "Available workflows" list keeps naming each sub-command; only
  the link targets collapse to the three files.

**Expected touch points**

- `docs/app.md`, `docs/cloudflare.md`, `docs/admin.md`, `docs/configuration.md` — new
- `docs/assign-build.md`, `docs/create-release.md`, `docs/publish.md`, `docs/rollback.md` — deleted
- `docs/create-worker.md`, `docs/create-worker-version.md`, `docs/deploy-version.md`, `docs/release.md` — deleted
- `README.md` — updated link list

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `docs/` contains exactly `app.md`, `cloudflare.md`, `admin.md`, and `configuration.md`.
- [ ] Every behavior documented in the eight deleted files is present in the new files.
- [ ] The environment settings material appears once, in `docs/configuration.md`.
- [ ] `docs/admin.md` documents all five `admin` sub-commands including `gen-secure-token`.
- [ ] `docs/admin.md` presents the bootstrap sequence in order and states that the bootstrap token is single-use.
- [ ] `docs/admin.md` states the credential prompt behavior and names the three environment variables.
- [ ] `README.md` links resolve to existing files, and no link points at a deleted file.
- [ ] No remaining file in the repository links to a deleted docs path.

**Validation**

- `grep -rn 'docs/' README.md` and a link check across the repository — every target exists
- Read each new file end to end against the deleted originals to confirm nothing was lost
- No lint or test run applies; this task changes no JavaScript

**Progress and handoff**

- Completed: Wrote `docs/app.md`, `docs/cloudflare.md`, `docs/admin.md`, and
  `docs/configuration.md`; deleted the eight old per-sub-command files; updated
  `README.md`'s link list and "Available workflows" list.
- Current state: Complete. All acceptance criteria met.
- Remaining: Nothing.
- Decisions and discoveries:
  - `docs/configuration.md`'s two-layer-merge description is sourced from the
    JSDoc module comment in `lib/config-loader.js` (home layer merged under
    the project layer, both deep-frozen) — that was the authoritative existing
    description; none of the eight old docs stated it themselves, they only
    named the two file paths repeatedly.
  - `docs/cloudflare.md` keeps `create-worker-version`'s full pipeline detail
    (all 8 phases, the sample-app section) verbatim from the old file — that
    content is specific to the command, not restated boilerplate. Only the
    credential/settings sentences that were pure repetition across files were
    replaced with a link to `docs/configuration.md`.
  - `docs/release.md`'s old relative links to `create-worker-version.md` and
    `publish.md` became same-file section links (`create-worker-version` above
    and `app.md`), since `release` now lives in the same file as
    `create-worker-version`.
  - The eight old files' content was carried over in full — verified by
    reading each new file against its source(s) rather than summarizing.
  - Interpreted "no remaining file in the repository links to a deleted docs
    path" as covering live navigational links (`README.md`, and the one
    inter-doc link in the old `release.md`), not the historical `agents/plans/`
    documents that record what earlier tasks did — rewriting those would
    falsify the historical record. Confirmed via `grep` that no other file
    contains a markdown link to any of the eight deleted paths.
  - Added the five `admin` sub-commands to README's "Available workflows"
    list. The task text only required fixing link targets, but the list would
    otherwise omit an entire top-level command with real capabilities as of
    this plan; `gen-secure-token` existed before this plan and was already
    undocumented in that list, so this closes that gap too.
- Actual files changed:
  - `docs/app.md`, `docs/cloudflare.md`, `docs/admin.md`, `docs/configuration.md` (new)
  - `docs/assign-build.md`, `docs/create-release.md`, `docs/publish.md`, `docs/rollback.md` (deleted)
  - `docs/create-worker.md`, `docs/create-worker-version.md`, `docs/deploy-version.md`, `docs/release.md` (deleted)
  - `README.md` (modified: link list and workflow list)
- Validation run:
  - `grep` across the repository for links to each deleted path — none found
    outside `agents/plans/` historical records
  - Read each new file against its deleted source(s) end to end
  - `node run-tests.js` (full suite) — 434/434 passed (no JS changed by this task)
  - `npm run lint` — clean
- Blockers: None.
