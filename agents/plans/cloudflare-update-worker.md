# Implementation Plan: Update Cloudflare Worker Configuration

## Implementation Approach

Add `kixx.js cloudflare update-worker --environment <name>`. It sends the
selected environment's complete `WORKER` block to the existing
`CloudflareApiClient#updateWorker()` (`PUT .../workers/workers/{name}`).

`PUT` is full replacement: Cloudflare resets omitted optional properties to
their defaults. The `WORKER` block is declarative desired state, shared with
`create-worker`. Documentation must say this prominently.

---

### Task UW-1: Add the `update-worker` command

**Status:** Not started
**Depends on:** None
**Documentation:** `commands/README.md`; `docs/cloudflare.md`; `test/README.md`

**Objective**

Operators can replace an existing Worker's Worker-level settings from
`cloudflare-config.js` without creating or deploying a Worker version.

**Scope**

- In: the command, its registration, unit tests, and documentation.
- Out: changes to `create-worker`, `create-worker-version`, or `release`;
  `PATCH`/partial updates; renames; fetching or diffing remote state;
  `--force` or prompts; Worker-version state.

**Design and invariants**

- Copy `commands/cloudflare/create-worker.js`. Only the client call changes:
  `client.updateWorker(workerConfig.name, workerConfig)`.
- Pass `WORKER` through unchanged. No local allowlist; Cloudflare validates.
- A missing `WORKER.name` fails through the client's `workerId` assertion, the
  same way `create-worker` fails. Do not add a separate check.

**Expected touch points**

- `commands/cloudflare/update-worker.js` — new command.
- `commands/cloudflare/index.js` — register `update-worker`.
- `test/unit-tests/commands/cloudflare/update-worker.test.js` — mirror
  `create-worker.test.js`.
- `README.md` — add to the command list.
- `docs/cloudflare.md` — new `update-worker` section; fix line ~130, which
  says Worker-level settings belong to `create-worker` and are not updated.

**Acceptance criteria**

- [ ] Missing `--environment` or `WORKER` block fails with a `UsageError`
      before any request.
- [ ] A valid run sends one `PUT` to the Worker named by `WORKER.name` with the
      `WORKER` block as its body, prints the result as four-space JSON plus a
      newline, and returns `0`.
- [ ] Docs warn that omitted `WORKER` fields reset to Cloudflare defaults and
      give a few example Worker-level fields (`observability`, `logpush`,
      `subdomain`).

**Validation**

- `npm test` — lint and full test suite.
- `node kixx.js cloudflare update-worker --help` — command discovery.
- Optional: run against a disposable Worker and confirm the setting changed
  and the deployment did not.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: `updateWorker()` and its HTTP test already exist;
  reuse them.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
