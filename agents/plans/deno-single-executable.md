# Implementation Plan: Deno Single Executable and JSONC Cloudflare Config

> **Status: Exploratory — DO NOT IMPLEMENT.**
>
> This plan records research and decisions only. Do not start any task below.
> Priority moved to preparing the devkit for distribution as remote CLI tools
> for Deno (`deno install` from JSR) and Node.js (npm) first. That work likely
> requires a static command registry, which invalidates DK-4's assumption that
> the filesystem registry is kept. Revisit and revise this plan after the
> remote CLI work lands.

## Implementation Approach

Ship the devkit as one self-contained `kixx` executable built with
`deno compile`, and move the project's own toolchain (tests, lint, type check)
from Node.js/npm to Deno. Replace the executable `cloudflare-config.js` with a
data file, `cloudflare-config.jsonc`, parsed by `jsonc-parser`.

Why Deno instead of a Go rewrite: the CSS parser, bundler, content
addressing, and API clients are already tested JavaScript whose output must
match the server byte for byte, and Deno runs this codebase almost unchanged. Probes done while
planning (Deno 2.8.1, macOS arm64):

- `deno run -A run-tests.js` — all 622 tests pass, same as Node.
- `deno run -A run-linter.js` — clean, same as Node.
- `deno compile --no-check -A --include commands kixx.js` — 73 MB binary; the
  filesystem command registry (`import.meta.url` + dynamic `import()`) works
  from embedded files; help, `admin gen-secure-token`, and a `cloudflare`
  command run from inside `tmp/sample-app`.
- Without `--no-check`, compile fails only on `TS2307: Cannot find module
  'kixx-assert'` (3 sites) — an import-map problem, not a code problem.

Why JSONC instead of JS config: the CLI will later write provisioned resource
IDs back into the config file. Writing safely into executable JS requires AST
editing and fails when values are computed. JSONC keeps comments for authors
and supports minimal-edit writes (`jsonc-parser` `modify` + `applyEdits`).
Writing is deferred; this plan only parses.

The Worker still needs the config as a JS module. The packager generates a
virtual `cloudflare-config.js` module (`export default {...};`) from the
parsed JSONC, so the application's `cloudflare-server.js` keeps
`import sourceConfig from './cloudflare-config.js'` unchanged.

Cross-cutting decisions:

- **Dependencies.** `jsonc-parser` is approved by the user (pin
  `npm:jsonc-parser@3.3.1`). The existing `kixx-assert`, `kixx-test`, and
  `kixx-linting` move from `package.json` to `deno.json` `imports` as exact
  `npm:` pins at their current versions. Add nothing else without asking.
- **CLI compatibility.** Command names, flags, positionals, exit codes, and
  output wording stay the same, except that the program name changes from
  `kixx.js` to `kixx`. Config locations (`~/.kixx`, `<project>/.kixx`, `.env`
  files, `example.env.secrets`, state files) are unchanged.
- **State hashes.** Byte-identical `modulesHash` across the switch is not
  required. The generated config module changes module content, so each
  environment uploads one new version on its first post-migration build.
  `configHash` and `bindingsHash` are unaffected. Document this.
- **Out of scope:** Node.js app deployments and `node-config.js` (the app
  template's `node-server.js` lives in another repo); writing to JSONC; Linux
  and Windows binaries (this version is macOS only); CI and
  release automation; macOS notarization; a `--version` flag; publishing to
  npm or JSR.

Tasks and dependencies:

```
DK-1 Deno toolchain ──┬── DK-2 JSONC config loader ── DK-3 Generated Worker config module
                      └── DK-4 Compiled `kixx` binary
```

DK-4 doc updates mention `cloudflare-config.jsonc`; if DK-4 lands before
DK-2/DK-3, the later task updates those references.

---

### Task DK-1: Run the project toolchain on Deno

**Status:** Not started
**Depends on:** None
**Documentation:** `README.md`; `AGENTS.md`; `test/README.md`;
`agents/docs/code-style-guide.md`

**Objective**

Developers lint, test, type-check, and run the CLI with Deno only. Node.js and
npm are no longer required to work on the project. Behavior of every command
is unchanged.

**Scope**

- In: `deno.json` (import map, tasks, lockfile), removal of npm metadata,
  making `deno check` pass, developer documentation.
- Out: JSONC (DK-2, DK-3), `deno compile` targets and the `kixx` program name
  (DK-4), rewriting tests to `Deno.test` (keep `kixx-test`).

**Design and invariants**

- `deno.json` `imports` maps bare specifiers to exact pins:
  `kixx-assert` → `npm:kixx-assert@2.1.1`, `kixx-test` → `npm:kixx-test@3.0.0`,
  `kixx-linting` → `npm:kixx-linting@1.1.2`. Source import statements stay
  bare; do not rewrite them to `npm:` specifiers.
- `kixx-assert` is a runtime dependency today despite being listed under
  `devDependencies`; the import map makes that irrelevant.
- Commit `deno.lock`. The repo previously ignored `package-lock.json` because
  it had no runtime dependencies; it now does.
- Tasks: `deno task lint`, `deno task test` (forwarding paths and `--skip`
  to `run-tests.js`), `deno task check`, and `deno task kixx` for running the
  CLI from source. Each task declares the permissions it needs. Tests write
  temp directories, so `test` needs `--allow-write`.
- Keep `node:` imports in source. Deno supports them; replacing them with
  `Deno.*` APIs is churn without benefit.
- Delete `package.json`. Remove `"engines"` intent by documenting the minimum
  Deno version (2.8 — the version verified) in `README.md`.
- `deno check` must pass with no `--no-check` escape hatch.

**Expected touch points**

- `deno.json`, `deno.lock` — new.
- `package.json` — delete.
- `.gitignore` — drop npm entries that no longer apply; keep `tmp/`.
- `run-tests.js`, `run-linter.js` — only if Deno requires changes.
- `README.md`, `AGENTS.md`, `test/README.md`, `commands/README.md`,
  `agents/docs/code-style-guide.md` — replace `node`/`npm` commands with
  `deno task` equivalents; describe Deno as the runtime.

**Acceptance criteria**

- [ ] With no `node_modules/` directory, `deno task test` runs all tests and
      passes.
- [ ] `deno task lint` is clean.
- [ ] `deno task check` passes for `kixx.js` and everything it imports.
- [ ] `deno task test test/unit-tests/lib` and `--skip <path>` work as
      `node run-tests.js` did.
- [ ] `deno task kixx` with no arguments prints the command list and exits 1;
      `deno task kixx admin gen-secure-token` exits 0.
- [ ] No developer documentation tells the reader to run `node` or `npm`.

**Validation**

- `rm -rf node_modules && deno task check && deno task lint && deno task test`
- `deno task kixx; echo $?` — expect help and `1`.
- `grep -rn "npm \|node run-\|node kixx" README.md AGENTS.md test commands docs agents/docs`
  — expect no hits.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task DK-2: Load `cloudflare-config.jsonc` instead of `cloudflare-config.js`

**Status:** Not started
**Depends on:** DK-1
**Documentation:** `docs/cloudflare.md`; `docs/configuration.md`;
`commands/README.md`

**Objective**

`cloudflare` commands read their configuration from
`<project>/cloudflare-config.jsonc`. The parsed object has the same shape the
JS module's default export had, so all downstream code is unchanged. The
devkit no longer executes project code to read configuration.

**Scope**

- In: the loader, its error reporting, the legacy-file guard, help labels,
  docs, tests, and converting `tmp/sample-app` locally for manual checks.
- Out: providing the config to the Worker (DK-3); writing to the file
  (future); `node-config.js`.

**Design and invariants**

- Parse with `jsonc-parser` `parseTree` (or `parse` with an error array)
  allowing comments and trailing commas. Any parse error is a `UsageError`
  naming the file, line, column, and the parser's error code. Never return a
  partially parsed object.
- Reject duplicate object keys with a `UsageError` naming the dotted path.
  `jsonc-parser` silently keeps the last value; a duplicate would make the
  future write-back target ambiguous.
- The top level must be an object, as today.
- If `cloudflare-config.js` exists in the project directory, fail with a
  `UsageError` telling the operator to convert it to
  `cloudflare-config.jsonc` and delete the JS file, whether or not the JSONC
  file also exists. Never silently prefer one.
- A missing JSONC file is a `UsageError` naming the expected path, as today.
- Rename `CLOUDFLARE_CONFIG_FILE_NAME` to the `.jsonc` name; help output
  heading becomes `Required cloudflare-config.jsonc settings:`.
- Keep the loader's injection seam for tests (file reading), consistent with
  `lib/config-loader.js`.

**Expected touch points**

- `lib/cloudflare-config-loader.js` — JSONC parsing, legacy guard.
- `kixx.js` — help heading.
- `test/unit-tests/lib/cloudflare-config-loader.test.js` — rewrite for JSONC.
- Comments referencing `cloudflare-config.js` in `lib/cloudflare/*.js` and
  `commands/cloudflare/create-worker-version.js` — update wording.
- `docs/cloudflare.md`, `docs/configuration.md`, `commands/README.md` — JSONC
  examples, a migration note (convert expressions such as `60 * 60` to
  literals with a comment), and the one-time re-upload note.

**Acceptance criteria**

- [ ] A JSONC file with line comments, block comments, and trailing commas
      loads to the expected object.
- [ ] Syntax errors, a non-object top level, and duplicate keys each fail
      with a `UsageError` naming the file and location or key path.
- [ ] A project holding `cloudflare-config.js` fails with the conversion
      message, with or without a JSONC file present.
- [ ] `requiredCloudflareConfig` checks behave as before against the parsed
      object.
- [ ] Unit tests cover each case above; existing `cloudflare` command tests
      pass.

**Validation**

- `deno task test test/unit-tests/lib/cloudflare-config-loader.test.js`
- `deno task test && deno task lint && deno task check`
- Manual: convert `tmp/sample-app/cloudflare-config.js` to JSONC, delete the
  JS file, and run `deno task kixx cloudflare create-worker-version --help`
  and a command that loads the config from that directory.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task DK-3: Generate the Worker's `cloudflare-config.js` module

**Status:** Not started
**Depends on:** DK-2
**Documentation:** `docs/cloudflare.md` (Processing pipeline, phase 5)

**Objective**

Uploaded Worker versions contain a module named `cloudflare-config.js` whose
default export is the parsed JSONC config, so an application's
`cloudflare-server.js` imports its config exactly as before while no such file
exists on disk.

**Scope**

- In: virtual-module support in the bundler, generating the module in the
  version pipeline, hashing implications, tests, docs.
- Out: Node.js app config; changes to the application template.

**Design and invariants**

- `bundleModules()` accepts a `virtualModules` map of module name (e.g.
  `./cloudflare-config.js`) to source. Resolution checks it before the
  filesystem. A virtual module is parsed and comment-stripped like any other,
  and may import nothing.
- Module source is
  `export default ${ JSON.stringify(cloudflareConfig, null, 4) };\n` — the
  whole config, all environments, matching what the JS file exposed before.
  Deterministic output keeps `modulesHash` stable between runs.
- The virtual module is included only if the module graph imports it. Do not
  force it into bundles that never reference it.
- A real `cloudflare-config.js` on disk is already rejected by DK-2, so there
  is no collision case to resolve here; still assert in the bundler that a
  virtual name never also resolves to a real file.
- Every code path that builds a version uses the same generation:
  `create-worker-version`, `release`, `bootstrap`. `recover-secret-version`
  compares remote modules only and needs no change — confirm.
- `modulesHash` changes once per environment after migration (accepted).
  `configHash` (from `WORKER_VERSION`) and `bindingsHash` must not change.

**Expected touch points**

- `lib/bundler/bundle-modules.js`, `lib/bundler/resolve-specifier.js` —
  virtual modules.
- `lib/cloudflare/create-worker-version.js` (and
  `lib/cloudflare/cloudflare-worker-version.js` if it builds the bundle) —
  generate and pass the virtual module.
- `test/unit-tests/lib/bundler/*` and
  `test/unit-tests/lib/cloudflare/*` — new cases.
- `docs/cloudflare.md` — project inputs, phase 5, sample application section.

**Acceptance criteria**

- [ ] An entry importing `./cloudflare-config.js` bundles with a generated
      module whose default export deep-equals the parsed JSONC.
- [ ] An entry that does not import it produces no such module.
- [ ] A virtual module with an import statement fails with a bundle
      diagnostic.
- [ ] Two runs over unchanged inputs produce identical `modulesHash`.
- [ ] `configHash` and `bindingsHash` are identical to those produced from an
      equivalent JS config before this change (fixture test).
- [ ] Docs describe the generated module and the one-time re-upload.

**Validation**

- `deno task test test/unit-tests/lib/bundler test/unit-tests/lib/cloudflare`
- `deno task test && deno task lint && deno task check`
- Manual, against `tmp/sample-app` with the JSONC config: run the bundle step
  (e.g. via a unit-level script or `create-worker-version` against a test
  account only with the user's permission) and confirm the module list
  includes `cloudflare-config.js` and the reachable-module count matches the
  pre-change count.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task DK-4: Build the `kixx` executable for macOS

**Status:** Not started
**Depends on:** DK-1
**Documentation:** `README.md`; `commands/README.md`; `docs/*.md`

**Objective**

`deno task compile` produces self-contained `kixx` executables for
darwin-arm64 and darwin-x64, and the CLI calls itself `kixx` everywhere. A user needs neither Node.js nor Deno
installed.

**Scope**

- In: macOS-only compile tasks, embedded command modules, permissions, program-name
  change, `dist/` output, install/build documentation.
- Out: Linux and Windows builds, CI, GitHub Release automation,
  signing/notarization, `--version`.

**Design and invariants**

- Targets and outputs (in gitignored `dist/`):
  - `aarch64-apple-darwin` → `dist/kixx-darwin-arm64`
  - `x86_64-apple-darwin` → `dist/kixx-darwin-x64`
- Keep the filesystem command registry; embed it with `--include commands`.
  Verified working in a compiled binary during planning. The commands
  directory contract in `commands/README.md` is unchanged.
- Compile with type checking on (no `--no-check`).
- Permissions are baked in at compile time. Start from least privilege:
  `--allow-read`, `--allow-write`, `--allow-net` (origins are user-configured,
  so net is unscoped), `--allow-env`, plus whatever `node:os`/TTY APIs need
  (e.g. `--allow-sys=homedir`). Determine the minimal set by exercising every
  command family; record the final set and why in handoff notes. Fall back to
  `-A` only with a recorded reason.
- Program name: usage lines print `kixx`, not `kixx.js`. Errors and recovery
  hints that print runnable commands (e.g. the `app assign-build` recovery
  command, `deploy-version` hints) must print `kixx ...`. Find them with
  `grep -rn "kixx.js" lib commands kixx.js`.
- `kixx.js` remains the source entry point for `deno task kixx`.
- Interactive prompts (`lib/prompt.js` masked input via raw mode) must work
  in the compiled binary on macOS.

**Expected touch points**

- `deno.json` — `compile` task building both macOS targets, and a
  `compile:local` task for the host platform.
- `.gitignore` — `dist/`.
- `kixx.js` — usage program name.
- `lib/**`, `commands/**` — printed command hints.
- Tests asserting output containing `kixx.js`.
- `README.md` — build and install instructions (copy binary onto `PATH`;
  macOS quarantine note for downloaded binaries), command list.
- `docs/*.md`, `commands/README.md` — `kixx.js` → `kixx` in examples.

**Acceptance criteria**

- [ ] `deno task compile` writes both macOS binaries without `--no-check`.
- [ ] On the host binary: no-arg help exits 1; `--help` at every level exits
      0; `admin gen-secure-token` prints a token; a `cloudflare` command run
      in a project directory loads `.kixx` and `cloudflare-config.jsonc`.
- [ ] Masked prompt works in the compiled binary
      (`admin accept-invite` against a non-routable origin, aborting after the
      prompts).
- [ ] Output and docs say `kixx`, not `kixx.js`, except where referring to
      the source entry file.
- [ ] The darwin-x64 binary runs `--help` (natively on Intel, or under
      Rosetta 2 via `arch -x86_64`).

**Validation**

- `deno task compile && ls -lh dist/`
- `./dist/kixx-darwin-arm64; echo $?` — help, `1`.
- `./dist/kixx-darwin-arm64 cloudflare deploy-version --help`
- From `tmp/sample-app`: `../../dist/kixx-darwin-arm64 cloudflare
  deploy-version -e production` — expect the Publishing API configuration
  usage error (proves config loading, no network write).
- `arch -x86_64 ./dist/kixx-darwin-x64 --help` — requires Rosetta 2.
- `grep -rn "kixx\.js" lib commands docs README.md` — only source-entry
  references remain.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: Planning probe showed a 73 MB darwin-arm64
  binary and a working embedded command registry.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
