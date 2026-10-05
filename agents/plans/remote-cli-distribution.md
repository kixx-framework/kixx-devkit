# Implementation Plan: Distribute the Devkit as a Remote CLI (npm and JSR)

## Implementation Approach

Publish the devkit as a global `kixx` executable on two registries from one
source tree:

- Node.js: `npm install -g kixx-devkit` → `kixx`.
- Deno: `deno install -g -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx`
  → `kixx`.

Deno becomes the development environment and the source of truth for tooling
and the version. The source stays plain JavaScript using `node:` built-ins so
the same files run unmodified on Node.js (npm users) and Deno (JSR users, and
the future `deno compile` binary in `deno-single-executable.md`).

Facts established while planning (Deno 2.8.1, Node 24.13.1, macOS arm64):

- `deno install -g` names the executable from the last segment of the
  specifier (`jsr:@std/http/file-server` → `file-server`). Neither JSR nor
  `deno.json` has a `bin` field. `jsr:@kixx/devkit` would install `devkit`;
  the `./kixx` subpath export makes `jsr:@kixx/devkit/kixx` install `kixx`.
  Avoid generic names: `jsr:@std/cli` fails with
  `Invalid executable name: @std`.
- The filesystem command registry cannot work from JSR: `import.meta.url` is
  an `https://jsr.io/...` URL, so `fileURLToPath()` and `readdir` in
  `kixx.js` and `lib/command-registry.js` fail. A static registry is required.
- A module loaded from a remote URL can dynamically `import()` a local
  `file://` module (verified with a local HTTP server), so loading the user's
  project config is not blocked by JSR.
- `deno publish` type-checks the graph. Resolving `kixx-assert` through
  `package.json` alone fails with `TS2307` (3 sites); an import-map entry
  passes. Vendoring `kixx-assert` (decision below) removes the issue.
- `"nodeModulesDir": "auto"` plus `npm:` entries in `deno.json` makes
  `deno install` populate `node_modules/`, and plain `node` resolves those
  packages. Node test runs need no npm tooling.
- `import manifest from './deno.json' with { type: 'json' }` works on Node 24
  and Deno, and `deno publish` ships `deno.json` in the package.
- `os.homedir()` on Deno requires `--allow-sys=homedir`.

Cross-cutting decisions (made with the user; do not revisit):

- **Runtime model.** One plain-JS source. Use `node:` built-ins only; no
  `Deno.*` APIs. Develop on Deno. Run the full test suite on Node 24 before
  every release.
- **Registries and names.** npm package `kixx-devkit` with
  `bin: { kixx: "./kixx.js" }`. JSR package `@kixx/devkit` exporting only
  `./kixx`. The `@kixx` JSR scope exists; `kixx-devkit` is free on npm.
- **CLI only.** Neither registry exposes a library API. No `main` or
  `exports` in `package.json`. The JSR warning
  `unsupported-javascript-entrypoint` is accepted.
- **Manifests.** `deno.json` owns name, version, exports, publish file list,
  tasks, and dev dependency pins. `package.json` is a minimal hand-maintained
  npm consumer manifest. A unit test asserts both versions match.
- **Zero runtime dependencies.** `kixx-assert` is vendored into
  `lib/vendor/kixx-assert/`, like `acorn`. Source and tests import the vendored
  copy. `deno.json` `imports` holds only the dev tools `kixx-test` and
  `kixx-linting`. DK-2 vendors `jsonc-parser` the same way. Add no
  dependency without asking the user.
- **Static command registry.** Eager static imports. Each sub-command class
  owns its `static description`. `commands/<command>/index.js` imports its
  classes; `commands/index.js` aggregates the commands.
- **Program name.** All output, `triggered_by` annotations, and docs say
  `kixx`. The source entry file stays `kixx.js`. Add `--version` / `-v`,
  reading the version from `deno.json`.
- **Deno permissions.** `-RWNE --allow-sys=homedir` (read, write, net, env,
  `sys=homedir`). No run or FFI: the CLI executes user-supplied config code.
  Read, write, and net cannot be scoped (paths and origins are runtime
  values); env stays unscoped because user config may read any variable. The
  same set is reused by `deno compile` later.
- **Release.** A GitHub Actions workflow triggered only by `v*` tags. No CI
  on push or pull requests; developers validate locally. Publishing is
  tokenless (OIDC) with provenance. Each publish step skips when its registry
  already has the version, so a re-run completes a partial release.
- **Versions.** First public release `0.1.0`. Node `>=24`. Deno `>=2.8`.
- **JSONC prerequisite.** The `cloudflare-config.jsonc` work (tasks DK-2 and
  DK-3 in `deno-single-executable.md`) lands before the first public publish
  so no published user ever migrates config formats. **Not met:** 0.1.0 was
  published before DK-2 and DK-3, and reads `cloudflare-config.js`. DK-2 is
  now a config-format change for published users (see RD-8 handoff).
- **Out of scope:** `deno compile` binaries (DK-4), CI on push/PR, Windows
  path testing, a library API, and writing to the JSONC config.

Tasks and dependencies:

```
RD-1 Vendor kixx-assert
  └── RD-2 Deno toolchain ──┬── RD-3 Static registry ── RD-4 `kixx` name + --version ──┐
                            └── (DK-2, DK-3 JSONC in deno-single-executable.md) ───────┤
RD-4 ── RD-5 Package manifests ──┬── RD-6 Install and permission verification ──────────┤
                                 └── RD-7 Release workflow ─────────────────────────────┤
                                                        RD-8 First public release 0.1.0 ┘
```

RD-8 depends on RD-6, RD-7, DK-2, and DK-3.

---

### Task RD-1: Vendor `kixx-assert`

**Status:** Complete
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`; `test/README.md`

**Objective**

The devkit has no runtime package dependency. Every `lib/`, `commands/`, and
test import of `kixx-assert` resolves to `lib/vendor/kixx-assert/mod.js`. This
is first because it removes the one runtime dependency before the toolchain
changes, and it works under the current Node tooling.

**Scope**

- In: copying `kixx-assert@2.1.1`, rewriting imports in `lib/`, `commands/`,
  and `test/`, removing `kixx-assert` from `package.json`.
- Out: `deno.json` (RD-2); any change to `kixx-assert` itself.

**Design and invariants**

- Copy `mod.js` and `LICENSE` from `kixx-assert@2.1.1` unmodified into
  `lib/vendor/kixx-assert/`. Record the source version in a short
  `lib/vendor/kixx-assert/README.md` (name, version, upstream URL), so a future
  upgrade knows what it replaces. Follow `lib/vendor/acorn/` for layout.
- `lib/vendor/` is already in the linter's `ignores`
  (`eslint.config.js`). Keep it that way.
- Imports use relative paths, e.g. `../vendor/kixx-assert/mod.js` from
  `lib/`, and `../../../lib/vendor/kixx-assert/mod.js` from tests at the
  matching depth. Use the correct depth per file.
- Tests import assertion helpers from the same vendored file, so only one copy
  of `AssertionError` exists.
- No bare `kixx-assert` specifier remains anywhere outside `node_modules/`.

**Expected touch points**

- `lib/vendor/kixx-assert/{mod.js,LICENSE,README.md}` — new.
- About 31 files in `lib/` and `commands/`, and about 65 in `test/` — import
  paths.
- `package.json` — remove `kixx-assert` from `devDependencies`.

**Acceptance criteria**

- [x] `grep -rn "from 'kixx-assert'" lib commands test kixx.js run-tests.js`
      returns nothing.
- [x] The full test suite passes with `node_modules/kixx-assert` deleted.
- [x] Lint is clean.

**Validation**

- `rm -rf node_modules/kixx-assert && node run-tests.js` — proves nothing
  resolves the npm copy.
- `npm run lint`

**Progress and handoff**

- Completed: `mod.js` and `LICENSE` copied unmodified from
  `node_modules/kixx-assert` (2.1.1) into `lib/vendor/kixx-assert/`, plus a
  README naming version and upstream. All 96 importing files rewritten to
  depth-correct relative paths. `kixx-assert` removed from `package.json`
  `devDependencies`.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: `mod.js` has no imports, so vendoring needed no
  edits. `test/README.md` updated: intro explains `kixx-assert` is vendored;
  examples use `../../../lib/vendor/kixx-assert/mod.js` (depth of
  `test/unit-tests/lib/*.test.js`). Its "File Conventions" section still
  shows stale `test/lib/...` paths; left alone (out of scope).
- Actual files changed: `lib/vendor/kixx-assert/{mod.js,LICENSE,README.md}`
  (new); 31 files in `lib/`+`commands/` and 64 in `test/unit-tests/`
  (imports); `test/README.md`; `package.json`.
- Validation run: with `node_modules/kixx-assert` deleted,
  `node run-tests.js` — 622 tests passed; `npm run lint` — clean; grep for
  `from 'kixx-assert'` — no hits.
- Blockers: None.

---

### Task RD-2: Run the project toolchain on Deno, with Node release verification

**Status:** Complete
**Depends on:** RD-1
**Documentation:** `README.md`; `AGENTS.md`; `test/README.md`;
`agents/docs/code-style-guide.md`

**Objective**

Developers lint, test, type-check, and run the CLI from source with
`deno task`. One task also runs the full test suite on Node.js. `deno.json`
becomes the source of truth for the version and dev dependencies. Behavior of
every command is unchanged.

**Scope**

- In: `deno.json`, `deno.lock`, tasks, stripping npm tooling fields from
  `package.json`, developer documentation.
- Out: npm consumer fields `bin`/`files` (RD-5); JSR `exports` and
  `publish` fields beyond what tasks need (RD-5); rewriting tests to
  `Deno.test` (keep `kixx-test`).

**Design and invariants**

- `deno.json`:
  - `name: "@kixx/devkit"`, `version: "0.1.0"`.
  - `nodeModulesDir: "auto"`.
  - `imports`: `kixx-test` → `npm:kixx-test@3.0.0`,
    `kixx-linting` → `npm:kixx-linting@1.1.2`. Exact pins. Source keeps bare
    specifiers.
  - Tasks, each declaring only the permissions it needs:
    - `lint` — `run-linter.js`, forwarding arguments.
    - `test` — `run-tests.js`, forwarding paths and `--skip`. Tests write
      temp directories.
    - `test:node` — `deno install && node run-tests.js`, forwarding
      arguments. `deno install` populates `node_modules/` for Node.
    - `check` — `deno check` on `kixx.js`, `run-tests.js`, and
      `run-linter.js`.
    - `kixx` — run `kixx.js` from source with the RD-6 permission set
      `-RWNE --allow-sys=homedir`, so development exercises the same
      permissions users get.
- Commit `deno.lock`. `package-lock.json` is already gitignored; delete the
  local file.
- `package.json`: remove `scripts`, `devDependencies`, `main`, and `exports`.
  Keep `name`, `version` (equal to `deno.json`), `type: "module"`,
  `engines.node: ">=24"`, and metadata fields. RD-5 adds `bin` and `files`.
- `run-tests.js` and `run-linter.js` must keep working under both `deno` and
  `node`. Change them only if a runtime requires it.
- Keep `node:` imports. Do not introduce `Deno.*` APIs.
- `deno check` passes with no `--no-check` escape hatch.

**Expected touch points**

- `deno.json`, `deno.lock` — new.
- `package.json` — stripped down.
- `.gitignore` — keep `node_modules/` and `tmp/`. Drop the
  "There are no dependencies" comment wording if it is now misleading.
- `README.md` — Development section: `deno task lint`, `deno task test`,
  `deno task test:node`, `deno task check`, `deno task kixx`. Minimum
  versions: Deno 2.8, Node 24.
- `AGENTS.md`, `test/README.md`, `agents/docs/code-style-guide.md` — replace
  `node run-tests.js` and `npm run lint` instructions with `deno task`
  equivalents. Linting instructions point at `deno task lint`.

**Acceptance criteria**

- [x] From a clean checkout with no `node_modules/`, `deno task check`,
      `deno task lint`, and `deno task test` pass.
- [x] `deno task test:node` runs the full suite on Node and passes.
- [x] `deno task test test/unit-tests/lib` and `--skip <path>` behave as
      `node run-tests.js` did.
- [x] `deno task kixx` with no arguments prints the command list and exits
      `1`. `deno task kixx admin gen-secure-token` exits `0`.
- [x] Developer docs tell the reader to use `deno task`, not `npm`.

**Validation**

- `rm -rf node_modules && deno task check && deno task lint && deno task test`
- `deno task test:node`
- `deno task kixx; echo $?` — help, then `1`.
- `grep -rn "npm run\|node run-tests" README.md AGENTS.md test/README.md agents/docs`
  — expect no hits.

**Progress and handoff**

- Completed: `deno.json` with name, version `0.1.0`, `nodeModulesDir`,
  pinned `imports`, and the five tasks; `deno.lock` generated;
  `package.json` stripped; developer docs switched to `deno task`.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - Task permissions, found by running with `--no-prompt` and widening only
    on `NotCapable`: `lint` = `-R --allow-sys=uid`; `test` =
    `-RWE --allow-sys=uid` (tests read `TMPDIR` via `os.tmpdir()` and set and
    delete fixture env vars); `kixx` = `-RWNE --allow-sys=homedir` as planned.
  - **On Deno, `fs.access()` requires `--allow-sys=uid`.** `lib/command-registry.js`
    and `lib/cloudflare-config-loader.js` used `fsp.access()` as an existence
    check, which made `deno task kixx admin gen-secure-token` fail with
    `NotCapable`. Both now use `fsp.stat()` (same semantics for the default
    `F_OK` check). RD-6 must still watch for other `node:` shims that need
    `sys` permissions; avoid `access()` in new code.
  - `exports: { "./kixx": "./kixx.js" }` added to `deno.json` now, because
    without it every `deno task` prints a warning. RD-5 still owns verifying
    it with `deno publish --dry-run`.
  - `package.json` `files: ["lib/"]` was removed as stale; RD-5 adds the
    correct list with `bin`.
  - `deno check` on plain JS (no `checkJs` / `@ts-check`) verifies module
    resolution only; a type error in a `.js` file does not fail it.
  - `deno task <name> <args>` appends args to the last command in the task,
    so `test:node` forwards to `node run-tests.js` as required.
  - `run-tests.js` and `run-linter.js` needed no changes. `run-tests.js`
    usage text still says `node run-tests.js`; left as-is.
- Actual files changed: `deno.json`, `deno.lock` (new); `package.json`;
  `.gitignore` (comment only); `README.md` (Development section);
  `AGENTS.md` (Linting); `commands/README.md` (verify block);
  `test/README.md` (how to run); `lib/command-registry.js`,
  `lib/cloudflare-config-loader.js` (`access` → `stat`).
- Validation run: after `rm -rf node_modules`: `deno task check`, `lint`,
  `test` (622 passed), `test:node` (622 passed) all exit 0;
  `deno task test test/unit-tests/lib` = 541 tests and
  `--skip test/unit-tests/lib/config-loader.test.js` = 616, matching
  `node run-tests.js`; `deno task kixx` prints commands, exits 1;
  `deno task kixx admin gen-secure-token` exits 0; docs grep for
  `npm run|node run-tests` — no hits.
- Blockers: None.

---

### Task RD-3: Replace the filesystem command registry with static imports

**Status:** Complete
**Depends on:** RD-2
**Documentation:** `commands/README.md`; `test/README.md`;
`agents/docs/code-style-guide.md`

**Objective**

The CLI finds commands through static imports, not `readdir` and
`import.meta.url`. Help output, command resolution, and errors for unknown
commands behave exactly as before. This removes the only code path that
cannot run from a JSR install, and lets `deno publish`, `deno install`, and
`deno compile` see the whole module graph.

**Scope**

- In: `commands/index.js`, every `commands/<command>/index.js`, every
  sub-command's `description`, `lib/command-registry.js`, `kixx.js` registry
  construction, `commands/README.md`, a registry conformance test.
- Out: program name and `--version` (RD-4); command behavior.

**Design and invariants**

- Each sub-command class declares its description directly:
  `static description = '...';`. Remove `import { subcommands } from './index.js'`
  from sub-command modules. If `index.js` imported the classes while classes
  imported `index.js`, evaluating `static description` would hit a TDZ error.
- `commands/<command>/index.js` exports `description` and `subcommands`, a map
  of sub-command name → class:
  ```js
  import PublishCommand from './publish.js';
  export const description = 'Publish application content';
  export const subcommands = { publish: PublishCommand };
  ```
- `commands/index.js` default-exports a map of command name → command index
  module namespace (`admin`, `app`, `cloudflare`).
- `CommandRegistry` takes that map in its constructor. It keeps its public
  methods (`commandExists`, `listCommands`, `listSubCommands`,
  `resolveCommand`) so `kixx.js` changes stay small. The methods may stay
  async or become sync. Choose one and update `kixx.js` to match. It no longer
  imports `node:fs/promises`, `node:path`, or `node:url`.
- Listing order stays alphabetical by name (current behavior uses
  `localeCompare` on directory names). Sub-command listing order is
  alphabetical too. Check current help output first; if it uses map insertion
  order, preserve that instead and record which.
- `resolveCommand` returns `null` for an unknown sub-command, as today.
- `kixx.js` no longer computes `devkitInstallDirectory`, and no longer
  imports `node:path` or `node:url` for that purpose. Check remaining uses
  before removing imports.
- The conformance test iterates the registry and asserts for every entry: the
  command has a non-empty `description`; each sub-command is a constructor
  with a non-empty string `static description`, and with `options`,
  `positionals`, and `required*` statics of the documented types when
  present. It also asserts that every `.js` file in each `commands/<command>/`
  directory except `index.js` is registered, so a forgotten registration
  fails the test. The test may read the filesystem; the CLI may not.

**Expected touch points**

- `commands/index.js` — new.
- `commands/{admin,app,cloudflare}/index.js` — import classes.
- `commands/**/*.js` (19 sub-commands) — inline descriptions.
- `lib/command-registry.js` — static lookup.
- `kixx.js` — construct the registry from `commands/index.js`.
- `test/unit-tests/commands/registry.test.js` (or the name `test/README.md`
  implies) — conformance test.
- `test/unit-tests/lib/command-registry.test.js` — new unit tests if the
  registry gains logic worth testing.
- `commands/README.md` — the new contract: create the module, then import it
  in the command's `index.js`. Remove "creating the files is what makes the
  command exist" and the "keep the two in sync" section.

**Acceptance criteria**

- [x] `grep -rn "readdir\|import.meta.url\|pathToFileURL" lib/command-registry.js kixx.js`
      returns nothing.
- [x] Help at every level (`kixx.js`, `kixx.js app --help`,
      `kixx.js app publish --help`) is byte-identical to the output before
      this task, except for intentional ordering decisions recorded in the
      handoff notes.
- [x] Unknown command and unknown sub-command produce the same messages and
      exit code `1` as before.
- [x] The conformance test passes, and fails if a sub-command file is not
      registered (check this by temporarily removing one entry).
- [x] `deno task check`, `deno task lint`, `deno task test`, and
      `deno task test:node` pass.

**Validation**

- Capture help output before the change into the agent scratchpad:
  `for c in "" admin app cloudflare; do deno task kixx $c --help; done > <scratchpad>/before.txt`,
  plus one sub-command `--help` per command. Repeat after the change and
  `diff`.
- `deno task test test/unit-tests/commands`
- `deno task check && deno task lint && deno task test && deno task test:node`

**Progress and handoff**

- Completed: descriptions inlined into all 19 sub-command classes (circular
  `import { subcommands } from './index.js'` removed); each
  `commands/<command>/index.js` imports its classes; new `commands/index.js`
  default-exports `{ admin, app, cloudflare }` namespaces; `CommandRegistry`
  rewritten as a static lookup; `kixx.js` builds it from the map;
  conformance and registry unit tests added; `commands/README.md` updated.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - Ordering: commands list alphabetically (`localeCompare`, as before);
    sub-commands list in `subcommands` **declaration order**, which is what
    the old code did (`Object.entries` of the index map). Not alphabetical,
    e.g. cloudflare lists `bootstrap` first. Preserved.
  - `CommandRegistry` methods are now synchronous; `kixx.js` dropped the
    `await`s. Lookups use `Object.hasOwn` so `kixx app constructor` and
    `kixx constructor` are "does not exist" rather than resolving
    `Object.prototype` members.
  - The import in `kixx.js` is `commandModules` (a local `commands` variable
    already exists in `main()`). `kixx.js` still imports `node:path` (used
    for the Cloudflare config filepath); `node:url` import removed.
  - Registry no longer validates that a sub-command is a function at
    runtime; the conformance test owns that.
  - Conformance test is `test/unit-tests/commands/index.test.js` (mirrors
    `commands/index.js`). It checks command directories ⇄ map keys, `.js`
    basenames ⇄ `subcommands` keys, each value `===` that module's default
    export, and the static contract types. RD-4 can add the `-v` short-flag
    check there.
  - `test/unit-tests/commands/cloudflare/bootstrap.test.js` compared
    descriptions via `subcommands`; it now asserts
    `subcommands.bootstrap === CloudflareBootstrapCommand`.
- Actual files changed: `commands/index.js` (new);
  `commands/{admin,app,cloudflare}/index.js`; 19 `commands/*/*.js`
  sub-command modules; `lib/command-registry.js`; `kixx.js`;
  `commands/README.md`; `test/unit-tests/commands/index.test.js` (new);
  `test/unit-tests/lib/command-registry.test.js` (new);
  `test/unit-tests/commands/cloudflare/bootstrap.test.js`.
- Validation run: help/error capture (top level, 3 commands, 3 sub-command
  `--help`, no args, unknown command, unknown sub-command, missing
  sub-command) diffed byte-identical before/after, exit codes included;
  conformance test failed when `list-migrations` was removed from
  `commands/admin/index.js`, passed after restore; `deno task check`,
  `lint`, `test` (631), `test:node` (631) all exit 0; acceptance grep — no
  hits.
- Blockers: None.

---

### Task RD-4: Rename the program to `kixx` and add `--version`

**Status:** Complete
**Depends on:** RD-3
**Documentation:** `README.md`; `commands/README.md`; `docs/*.md`

**Objective**

Every user-facing string names the program `kixx`, matching the installed
executable. `kixx --version` and `kixx -v` print the package version from
`deno.json`.

**Scope**

- In: usage lines, recovery hints, error messages, `triggered_by`
  annotations, tests asserting those strings, user docs, `--version`/`-v`.
- Out: renaming the source file `kixx.js`; install instructions (RD-6).

**Design and invariants**

- `kixx.js` prints `Usage: kixx ...`.
- Replace every runnable command hint `kixx.js <command> ...` with
  `kixx <command> ...`. Known sites: `lib/cloudflare/create-worker-version.js`
  (`TRIGGERED_BY`, `BOOTSTRAP_TRIGGERED_BY`, and hints),
  `commands/cloudflare/{set-secret,set-secrets,delete-secret,bootstrap}.js`,
  `commands/app/publish.js`, `commands/admin/run-migration.js`. Find the rest
  with `grep -rn "kixx\.js" lib commands kixx.js test docs`.
- `triggered_by` values sent to Cloudflare change to `kixx cloudflare ...`.
  This only affects metadata on new versions; nothing reads it back.
- References to the source entry file itself (e.g. "`kixx.js` dispatches to
  commands" in developer docs) keep `kixx.js`.
- `--version` / `-v`:
  - `kixx.js` reads the version with
    `import manifest from './deno.json' with { type: 'json' };`.
  - Prints `manifest.version` followed by a newline to stdout, and exits `0`.
  - Handled before command resolution, at the top level only. Decide whether
    `kixx app --version` prints the version or is an error, and record it.
    The recommended choice is that any `--version`/`-v` before a command
    runs prints the version.
  - Add `version` to the global options in help output with
    `short: 'v'`.
  - Make sure `-v` is not already a short flag on any sub-command; the
    registry conformance test can assert this.
- `deno.json` must ship in both packages (RD-5).

**Expected touch points**

- `kixx.js` — usage name, `--version`.
- `lib/**`, `commands/**` — hints and annotations.
- `test/unit-tests/**` — expected strings.
- `docs/*.md`, `README.md`, `commands/README.md` — command examples
  (`kixx.js app publish` → `kixx app publish`).

**Acceptance criteria**

- [x] `grep -rn "kixx\.js" lib commands docs README.md` returns only
      references to the source file.
- [x] `deno task kixx --version` and `deno task kixx -v` print `0.1.0` and
      exit `0`. So does `node kixx.js --version`.
- [x] Top-level help lists `--version`.
- [x] Tests cover `--version` and the updated strings. All tasks pass.

**Validation**

- `deno task kixx -v; echo $?` and `node kixx.js --version`
- `grep -rn "kixx\.js" lib commands docs README.md`
- `deno task check && deno task lint && deno task test && deno task test:node`

**Progress and handoff**

- Completed: every runnable hint, usage line, and `triggered_by` value says
  `kixx`; `--version`/`-v` added; tests and docs updated.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - `--version`/`-v` is checked first in `main()`, before help and command
    resolution. Because the top-level `parseArgs` is non-strict over the whole
    argv, `kixx app publish -v` also prints the version (the recommended
    choice). Same caveat as `-h` today: `--some-string-option -v` would be
    read as the version flag.
  - Top-level help (no args, `--help`, unknown command) now renders an
    `Options:` section with `--help` and `--version`; it had none before.
    Sub-command help also lists `--version` (global options are merged).
  - **Linter:** `import ... with { type: 'json' }` is ES2025; the linter
    rejected it at `ecmaVersion: 2022`. `eslint.config.js` now uses
    `ecmaVersion: 2025` globally, and `agents/docs/code-style-guide.md`
    (Language Standard) allows JSON import attributes as the one post-2022
    feature. A per-file override was tried and rejected: in `kixx-linting`,
    once any config object has `files`, only files matching some `files`
    entry are linted, so it silently stopped linting everything but
    `kixx.js`. Do not add `files` to `eslint.config.js` without listing every
    target.
  - Test coverage of `--version` needs a subprocess:
    `test/unit-tests/kixx.test.js` runs `kixx.js` with `process.execPath`
    (on Deno with `run -RWNE --allow-sys=homedir --no-prompt`, so it also
    guards the user permission set). The `test` task gained `--allow-run`
    (dev only; the CLI permission set is unchanged).
  - `test/unit-tests/commands/index.test.js` now rejects sub-command options
    named `help`/`version` or with short `h`/`v`. Verified it fails by
    temporarily giving `gen-secure-token` `short: 'v'`.
  - `docs/cloudflare.md` had `node kixx.js cloudflare deploy-version`; now
    `kixx cloudflare deploy-version`.
  - Kept as source-file references: `README.md:9`, `commands/README.md:4,33`.
- Actual files changed: `kixx.js`; `eslint.config.js`; `deno.json` (`test`
  task `--allow-run`); `agents/docs/code-style-guide.md`;
  `lib/cloudflare/create-worker-version.js`;
  `commands/admin/run-migration.js`, `commands/app/publish.js`,
  `commands/cloudflare/{bootstrap,delete-secret,set-secret,set-secrets}.js`;
  `docs/{admin,app,cloudflare}.md`; `README.md`; `commands/README.md`;
  tests: `test/unit-tests/kixx.test.js` (new),
  `test/unit-tests/commands/index.test.js`,
  `test/unit-tests/commands/cloudflare/{bootstrap,delete-secret,set-secret,set-secrets}.test.js`,
  `test/unit-tests/lib/cloudflare/{cloudflare-api-client,create-worker-version,manage-worker-secrets}.test.js`.
- Validation run: `deno task kixx -v` → `0.1.0`, exit 0; `deno task kixx
  --version` and `node kixx.js --version` → `0.1.0`; acceptance grep shows
  only the three source-file references; `deno task check`, `lint`, `test`
  (634), `test:node` (634) all exit 0.
- Blockers: None.

---

### Task RD-5: Define the npm and JSR package contents

**Status:** Complete
**Depends on:** RD-4
**Documentation:** `README.md`

**Objective**

`npm pack` and `deno publish --dry-run` produce packages containing exactly
what the CLI needs, and a unit test keeps the two manifests consistent.

**Scope**

- In: `package.json` `bin`/`files`, `deno.json` `exports`/`publish`, the
  manifest consistency test, README links that work on registry pages.
- Out: installing and exercising the packages (RD-6); publishing (RD-7,
  RD-8).

**Design and invariants**

- `package.json`:
  - `bin: { "kixx": "./kixx.js" }`. `kixx.js` keeps its
    `#!/usr/bin/env node` shebang and executable mode.
  - `files: ["kixx.js", "commands/", "lib/", "deno.json"]`. npm adds
    `README.md`, `LICENSE`, and `package.json` automatically. Exclude
    `commands/README.md` only if it is noise; record the decision.
  - No `dependencies`, `devDependencies`, `scripts`, `main`, or `exports`.
- `deno.json`:
  - `exports: { "./kixx": "./kixx.js" }`.
  - `publish.include`: `kixx.js`, `commands/`, `lib/`, `README.md`,
    `LICENSE`. JSR includes `deno.json` automatically; confirm in the dry run.
    Nothing from `test/`, `tmp/`, `agents/`, or `docs/`.
- README links into `docs/` must work on npmjs.com and jsr.io, where relative
  links do not resolve. Use absolute GitHub URLs on the default branch.
- Consistency test (`test/unit-tests/manifests.test.js` or equivalent) asserts:
  - `package.json` version equals `deno.json` version.
  - `package.json` has no `dependencies`.
  - `package.json` `bin.kixx` and `deno.json` `exports["./kixx"]` both point
    at `kixx.js`.
  - `deno.json` `imports` contains no runtime package (only `kixx-test` and
    `kixx-linting`).
- `deno publish --dry-run` warnings: `unsupported-javascript-entrypoint` is
  accepted. No `unanalyzable-dynamic-import` warnings remain after RD-3. The
  dynamic import of the user's Cloudflare config file may still warn; that is
  expected and must be documented in handoff notes. DK-2 removes it.

**Expected touch points**

- `package.json`, `deno.json`.
- `test/unit-tests/manifests.test.js` — new.
- `README.md` — absolute doc links.

**Acceptance criteria**

- [x] `npm pack --dry-run` lists only `kixx.js`, `commands/**`, `lib/**`,
      `deno.json`, `README.md`, `LICENSE`, and `package.json`.
- [x] `deno publish --dry-run` succeeds, its file list matches the
      intended set, and its only warnings are the accepted ones.
- [x] The consistency test passes, and fails when either version is changed
      alone.

**Validation**

- `npm pack --dry-run`
- `deno publish --dry-run`
- `deno task test test/unit-tests/manifests.test.js`

**Progress and handoff**

- Completed: `package.json` `bin`/`files`; `deno.json` `publish`
  include/exclude (`exports` was added in RD-2); README doc links made
  absolute; `test/unit-tests/manifests.test.js` added.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries:
  - `commands/README.md` is **excluded** from both packages (developer-only
    contract for adding commands): `"!commands/README.md"` in npm `files`,
    `publish.exclude` in `deno.json`.
  - Both packages ship the same 114 files (npm adds `package.json`): 23
    under `commands/` (19 sub-commands, 3 command indexes,
    `commands/index.js`), 87 under `lib/` (34 in `lib/vendor/`), `kixx.js`,
    `deno.json`, `README.md`, `LICENSE`. JSR includes `deno.json`
    automatically, confirmed in the dry run.
  - `deno publish --dry-run` warnings, both expected:
    `unsupported-javascript-entrypoint` (accepted), and
    `unanalyzable-dynamic-import` at `lib/cloudflare-config-loader.js:31`
    (loads the user's `cloudflare-config.js`; DK-2 removes it). No
    registry-related dynamic-import warnings remain after RD-3.
  - The dry run needs `--allow-dirty` on an uncommitted tree; the release
    workflow (RD-7) publishes from a clean tag checkout and does not.
  - README links use reference-style definitions pointing at
    `https://github.com/kixx-framework/kixx-devkit/blob/main/...` (`main` is
    the remote default branch).
  - `kixx.js` is mode `100755` in git; shebang `#!/usr/bin/env node` kept.
- Actual files changed: `package.json`, `deno.json`, `README.md`,
  `test/unit-tests/manifests.test.js` (new).
- Validation run: `npm pack --dry-run` — 115 files, the set above;
  `deno publish --dry-run --allow-dirty` — exit 0, 2 expected warnings;
  manifest test passes, and failed when only `package.json` was set to
  `0.1.1` and when only `deno.json` was set to `0.2.0` (both restored);
  `deno task check`, `lint`, `test` (637), `test:node` (637) all exit 0.
- Blockers: None.

---

### Task RD-6: Verify installed executables and document installation

**Status:** Complete
**Depends on:** RD-5
**Documentation:** `README.md`; `docs/configuration.md`

**Objective**

Packages installed the way users will install them produce a working `kixx`
on Node and on Deno. The Deno permission set `-RWNE --allow-sys=homedir` is
shown sufficient for every command family. README install instructions are
correct.

**Scope**

- In: local install of the npm tarball and of the Deno entry point into
  scratch install roots, exercising every command family, any code fixes
  found, README install section.
- Out: installing from the live registries (RD-8).

**Design and invariants**

- Install into the agent scratchpad, never the user's global prefix:
  - npm: `npm pack`, then `npm install -g --prefix <scratch>/npm <tarball>`.
    Run `<scratch>/npm/bin/kixx`.
  - Deno: `deno install -g --root <scratch>/deno -RWNE --allow-sys=homedir -n kixx ./kixx.js`.
    The local path needs `-n`; the JSR subpath gets the name by inference
    (verified during planning with `jsr:` packages).
- Run from inside a project directory (e.g. `tmp/sample-app`) so config
  loading runs. Use `--no-prompt` on Deno where possible, so a missing
  permission fails instead of prompting.
- Exercise per family without writing to real remote services:
  - top level: no args (exit `1`), `--help`, `--version`.
  - `admin gen-secure-token` — full run.
  - `admin accept-invite` against a non-routable origin — prompts work,
    then the network error is a connection failure, not `NotCapable`.
  - `cloudflare deploy-version -e production` — loads `.kixx` and Cloudflare
    config; expect a configuration usage error.
  - `app publish --help` and one `app` command reaching config validation.
- A `NotCapable` error at any point is a defect in the permission set or in
  the code. Fix the code if it does something it should not (e.g. spawning a
  process). Change the documented flag set only with the user's agreement.
- README "Install" section, before "CLI Commands":
  - `npm install -g kixx-devkit` (Node >= 24).
  - `deno install -g -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx`
    (Deno >= 2.8), a one-line explanation of each permission, and why
    subprocess and FFI access are not granted.
  - Upgrading: `npm install -g kixx-devkit@latest`; `deno install -g -f ...`
    with the same flags.
  - Verify with `kixx --version`.

**Expected touch points**

- `README.md` — Install section.
- `docs/configuration.md` — permission note if config loading needs one.
- Code under `lib/` only if a defect is found.

**Acceptance criteria**

- [x] Both installed executables pass every check above.
- [x] No `NotCapable` error under `-RWNE --allow-sys=homedir --no-prompt`.
- [x] README install instructions match what was tested.

**Validation**

- The install and run commands above, with output recorded in handoff notes.
- `deno task check && deno task lint && deno task test && deno task test:node`
  if code changed.

**Progress and handoff**

- Completed: npm tarball and local Deno entry point installed into scratch
  roots; every check passed on both; README Install section and a
  `docs/configuration.md` permission note added. No code defects found in
  this task (the `fs.access` → `fs.stat` fix for `sys=uid` was already made
  in RD-2).
- Current state: Complete.
- Remaining: Nothing. Installing from the live registries is RD-8.
- Decisions and discoveries:
  - Test harness: a throwaway project in the agent scratchpad (not
    `tmp/sample-app`, which holds secrets files) with `.kixx/config.json`
    origins at `http://127.0.0.1:59999`, empty `secrets.json`, and
    `cloudflare-config.js` exporting `{}`. Every run used `HOME=<scratch>/home`
    so the user's real `~/.kixx` layer could not supply credentials, and
    `DENO_NO_PROMPT=1` so a missing permission fails.
  - Use an unblocked port for network checks: Node's fetch rejects port 9
    ("bad port", a fetch-spec blocked port) without connecting.
  - Interactive prompts verified through a pseudo-terminal
    (`script -q /dev/null kixx ...` with paced input; unpaced piped input
    reaches EOF before the prompt reads).
  - `deno install` of a local path writes a shim that runs the source file in
    place with `--config <root>/bin/.kixx/deno.json`; the JSR install is
    verified in RD-8.
  - Neither `lib/`, `commands/`, nor `kixx.js` uses `child_process`,
    `Deno.Command`, or FFI.
- Actual files changed: `README.md` (Install section),
  `docs/configuration.md` (permission note).
- Validation run (identical results for `<scratch>/npm/bin/kixx` and
  `<scratch>/deno/bin/kixx`):
  - no args → command list, exit 1; `--help` → exit 0; `--version` →
    `0.1.0`, exit 0.
  - `admin gen-secure-token` → 64-hex token, exit 0.
  - `admin accept-invite -e rd6check` with env-var inputs and with TTY
    prompts → `AdminApiError` caused by `ECONNREFUSED` (Node) /
    `Connection refused (os error 61)` (Deno), exit 1.
  - `cloudflare deploy-version -e production` → loads `cloudflare-config.js`
    and `.kixx`, then `Missing required secrets ... cloudflare.accountId,
    cloudflare.apiToken`, exit 1.
  - `app publish --help` → exit 0; `app publish -e rd6check` →
    `Missing required setting app.environments.rd6check.publishingToken`,
    exit 1.
  - No `NotCapable` anywhere. `deno install -g -f ...` reinstall works.
- Blockers: None.

---

### Task RD-7: Add the tag-triggered release workflow

**Status:** Complete
**Depends on:** RD-5
**Documentation:** `README.md`

**Objective**

Pushing a `v<version>` tag verifies the release and publishes it to JSR and
npm with provenance, with no stored tokens. Re-running the workflow after a
partial failure completes the release.

**Scope**

- In: `.github/workflows/release.yml`, a release section in `README.md`.
- Out: CI on push or pull requests (rejected by the user); registry account
  setup (RD-8, done by the user).

**Design and invariants**

- Trigger: `push` of tags matching `v*` only.
- Workflow permissions: `contents: read`, `id-token: write`.
- Pin `denoland/setup-deno` to Deno 2.8.x and `actions/setup-node` to Node
  24. Pin actions to full commit SHAs or exact versions.
- Steps, in order, failing fast:
  1. Assert tag `v<x>` equals `deno.json` `version` and `package.json`
     `version`.
  2. `deno task check`, `deno task lint`, `deno task test`,
     `deno task test:node`.
  3. JSR: skip if `https://jsr.io/@kixx/devkit/meta.json` lists the version;
     otherwise `deno publish`.
  4. npm: skip if `npm view kixx-devkit@<version> version` succeeds;
     otherwise `npm publish --provenance --access public`. npm trusted
     publishing needs a minimum npm CLI version. Check npm's current docs and
     upgrade npm in the job if Node 24's bundled npm is older.
- A skip prints which registry already had the version.
- Do not run the workflow. It runs for real only in RD-8.

**Expected touch points**

- `.github/workflows/release.yml` — new.
- `README.md` — "Releasing" section: bump both versions, run local
  validation, commit, tag `v<version>`, push the tag.

**Acceptance criteria**

- [x] The workflow file is valid YAML and the logic matches the steps above.
- [x] The skip checks work, verified locally against the registries for an
      existing package version and a nonexistent one, e.g. `curl` the JSR
      meta URL and `npm view` for a known package.
- [x] README documents the release procedure.

**Validation**

- `actionlint .github/workflows/release.yml` if the user has it installed;
  otherwise a YAML parse, e.g. `deno eval` with `jsr:@std/yaml`, plus review.
  Do not install tools without asking.
- Manual run of the skip-check commands.

**Progress and handoff**

- Completed: `.github/workflows/release.yml` and the README "Releasing"
  section.
- Current state: Complete. The workflow has never run; RD-8 is its first
  real run.
- Remaining: Nothing.
- Decisions and discoveries:
  - Actions pinned to commit SHAs (tags dereferenced with `git ls-remote`):
    `actions/checkout` v7.0.1 `3d3c42e5…`, `denoland/setup-deno` v2.0.5
    `22d081ff…` with `deno-version: 2.8.x`, `actions/setup-node` v7.0.0
    `82076278…` with `node-version: 24` and `registry-url`.
  - npm docs (fetched 2026-10-05): trusted publishing needs npm >= 11.5.1
    and Node >= 22.14.0; provenance is automatic (the `--provenance` flag is
    kept as the plan asked; harmless); **`package.json` `repository.url`
    must exactly match the GitHub repository**. Currently
    `https://github.com/kixx-framework/kixx-devkit.git`. If the npm trusted
    publish fails with a provenance/repository mismatch in RD-8, check this
    first. The npm step upgrades npm to `npm@11` only when the bundled npm is
    older than 11.5.1 (`sort -V` compare; no extra packages). Local Node
    24.13.1 bundles npm 11.12.1.
  - JSR skip check: `meta.json` returns 404 for a package with no versions
    (currently `@kixx/devkit`), so 404 means "publish"; any status other than
    200/404 fails the job. The meta file is written to `$RUNNER_TEMP`
    because `deno publish` refuses a dirty working tree.
  - npm skip check compares `npm view kixx-devkit@<v> version` output to the
    version rather than trusting the exit code.
  - Step scripts use the variable name `status`, which is read-only in zsh;
    they run in bash on the runner. Test them locally with `bash`, not zsh.
- Actual files changed: `.github/workflows/release.yml` (new), `README.md`.
- Validation run: `actionlint` not installed (not installed per AGENTS.md);
  YAML parsed with `jsr:@std/yaml` via `deno eval` (trigger `push.tags: v*`,
  permissions `contents: read`, `id-token: write`, 10 steps in order).
  Skip logic run under bash: `@std/cli@0.207.0` skip, `@std/cli@99.0.0`
  publish (200), `@kixx/devkit@0.1.0` publish (404); `kixx-test@3.0.0`
  skip, `kixx-test@99.9.9` and `kixx-devkit@0.1.0` publish; npm version
  gate: 11.4.2 and 10.9.0 upgrade, 11.5.1 and 11.12.1 do not; tag `v0.1.0`
  matches both manifests.
- Blockers: None.

---

### Task RD-8: Publish 0.1.0 to npm and JSR

**Status:** Complete
**Depends on:** RD-6, RD-7, DK-2, DK-3 (`deno-single-executable.md`)
**Documentation:** `README.md`

**Objective**

`kixx-devkit@0.1.0` is on npm and `@kixx/devkit@0.1.0` is on JSR, and both
install a working `kixx` from the live registries.

**Scope**

- In: the user's registry setup, the first npm publish, tagging, verifying
  installs from the registries.
- Out: any code change. Defects found here go back to the owning task.

**Design and invariants**

- An agent must not publish, push tags, or change registry settings. The
  user performs every outward-facing step. The agent prepares commands and
  verifies results.
- npm trusted publishing can only be configured on a package that already
  exists, so the first npm publish is manual and has no provenance. JSR
  requires the package to be created and linked to the GitHub repository
  before the first publish. The workflow then publishes JSR and skips npm.
- Registry facts checked 2026-10-05 (npm and JSR docs): npm's trusted
  publisher form takes the workflow file name only (`release.yml`, not the
  path); npm recommends "Require two-factor authentication and disallow
  tokens" once trusted publishing works; JSR authenticates `deno publish`
  from Actions through the repository link plus `id-token: write`.

**Operator runbook**

Every step below is performed by the maintainer. Commands assume the
repository root.

0. Preconditions.
   - [ ] DK-2 and DK-3 are complete and their work is merged. **Not met at
     release:** both were still Not started; 0.1.0 shipped without them.
   - [x] `distribution` is merged into `main`. README doc links point at
     `blob/main/...`, so the docs must be on `main` before the packages
     appear on the registries.
   - [x] `deno.json` and `package.json` both say `"version": "0.1.0"`.
   - [x] The name is still free: `npm view kixx-devkit` returns `E404`.
   - [x] Record the release commit: `git rev-parse origin/main`. `0b639e4653dd3748644ca37cc5a412245403af36`

1. Create the JSR package.
   - [x] Go to <https://jsr.io/new>. Scope `@kixx`, package name `devkit`.
     Create it.
   - [x] Open `https://jsr.io/@kixx/devkit` → Settings. Under GitHub
     repository, enter `kixx-framework/kixx-devkit` and click Link.

2. Publish to npm by hand from a clean checkout of the release commit.
   ```
   git clone git@github.com:kixx-framework/kixx-devkit.git /tmp/kixx-release
   cd /tmp/kixx-release
   git checkout <release commit>
   deno task check && deno task lint && deno task test && deno task test:node
   deno publish --dry-run
   npm pack --dry-run
   ```
   - `deno publish --dry-run` should show only the
     `unsupported-javascript-entrypoint` warning (the
     `unanalyzable-dynamic-import` warning goes away with DK-2).
   - `npm pack --dry-run` should list `kixx.js`, `commands/**` (no
     `commands/README.md`), `lib/**`, `deno.json`, `README.md`, `LICENSE`,
     and `package.json`, and nothing from `test/`, `docs/`, or `agents/`.
   - Then publish, entering the 2FA code when prompted:
     ```
     npm whoami || npm login
     npm publish --access public
     ```
   - Check: `npm view kixx-devkit@0.1.0 version` prints `0.1.0`.

3. Configure npm trusted publishing.
   - <https://www.npmjs.com/package/kixx-devkit> → Settings → Trusted
     Publisher → GitHub Actions:
     - Organization or user: `kixx-framework`
     - Repository: `kixx-devkit`
     - Workflow filename: `release.yml`
     - Environment: leave empty (the workflow uses none).
   - Leave Publishing access as it is until the first tag-driven npm
     publish works (0.1.1 or later); then select "Require two-factor
     authentication and disallow tokens".

4. Tag and push the release.
   ```
   git tag v0.1.0 <release commit>
   git push origin v0.1.0
   ```
   - Watch the Release workflow under the repository's Actions tab. Expected
     log lines: the version check passes, all tests pass, "Publish to JSR"
     runs `deno publish`, and "Publish to npm" prints
     `npm already has kixx-devkit@0.1.0; skipping.`
   - If JSR fails on authentication, check the step 1 repository link, then
     use "Re-run jobs". Re-running is safe: each publish step skips a
     version its registry already has.
   - If a code defect turns up, do not move the tag. npm `0.1.0` is
     already permanent. Fix it on `main`, bump both manifests to `0.1.1`,
     and release that.

5. Hand verification to an agent (or run it yourself): the acceptance
   criteria below, installing into scratch directories rather than the
   global prefix.

Later releases use only the "Releasing" steps in `README.md`: bump both
versions, validate, commit, then tag `v<version>` and push the tag. The first
of those releases is the first npm publish with provenance. If it fails with
a repository mismatch, check that `package.json` `repository.url` matches
`https://github.com/kixx-framework/kixx-devkit`.

**Expected touch points**

- None in the repository, unless the README needs corrections found during
  verification.

**Acceptance criteria**

- [x] `npm view kixx-devkit@0.1.0` and `https://jsr.io/@kixx/devkit/meta.json`
      show 0.1.0.
- [x] `npm install -g --prefix <scratch> kixx-devkit` and
      `deno install -g --root <scratch> -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx`
      both install an executable named `kixx` that prints `0.1.0` for
      `--version`. The Deno install works without `--name`.
- [x] The RD-6 command checks pass on both registry installs.

**Validation**

- The install commands above, into the scratchpad.
- The release workflow run log shows JSR published and npm skipped.

**Progress and handoff**

- Completed: the maintainer ran runbook steps 1 to 4 on 2026-10-05:
  `kixx-devkit@0.1.0` published to npm by hand, `@kixx/devkit@0.1.0`
  published to JSR by the Release workflow from tag `v0.1.0`. The agent
  verified both registries and both installs.
- Current state: Complete, with one documented exception (below).
- Remaining: Nothing in this plan. Follow-ups: DK-2 and DK-3, and turning
  on npm "Require two-factor authentication and disallow tokens" after the
  first tag-driven npm publish works.
- Decisions and discoveries:
  - **Exception: released without DK-2/DK-3.** Release commit `0b639e4`
    (merge of PR #9) still loads `cloudflare-config.js`. The JSONC
    prerequisite decision was not met, so published users may already have
    `cloudflare-config.js` files. DK-2's legacy-file guard and migration
    note now serve real users; the DK-2 handoff records this.
  - Release commit and tag: `v0.1.0` → `0b639e4653dd3748644ca37cc5a412245403af36`,
    which is also `origin/main`.
  - Workflow run `37349588841` (25s, success): version check passed; 637
    tests passed on Deno and on Node; "Publish to JSR" printed
    `Successfully published @kixx/devkit@0.1.0` with a Sigstore
    provenance log entry; "Publish to npm" printed
    `npm already has kixx-devkit@0.1.0; skipping.` JSR warnings were the
    two expected ones, including `unanalyzable-dynamic-import` at
    `lib/cloudflare-config-loader.js:31` (still present because DK-2 has
    not landed).
  - npm `0.1.0` has no provenance (manual first publish, as planned). The
    first provenance publish to npm is the next tag-driven release.
  - The JSR install of `jsr:@kixx/devkit/kixx` loads the project's local
    `cloudflare-config.js` through a dynamic `import()`, which confirms the
    planning fact that a module from a remote URL can import a local
    `file://` module.
- Actual files changed: none in the repository (only this plan and the
  DK-2 handoff in `deno-single-executable.md`).
- Validation run (2026-10-05, agent):
  - `npm view kixx-devkit@0.1.0 version` → `0.1.0`;
    `https://jsr.io/@kixx/devkit/meta.json` → `latest: 0.1.0`,
    versions `[0.1.0]`.
  - `npm install -g --prefix <scratch>/npm kixx-devkit` and
    `deno install -g --root <scratch>/deno -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx`
    (no `--name`) each installed `bin/kixx`; both print `0.1.0` for
    `--version`.
  - RD-6 checks on both installs, using the RD-6 harness (scratch project,
    `HOME=<scratch>/home`, `DENO_NO_PROMPT=1`): no args exit 1; `--help`
    exit 0; `admin gen-secure-token` exit 0; `admin accept-invite` with env
    inputs and with TTY prompts (Deno) fails on connection refused;
    `cloudflare deploy-version -e production` loads config, then
    `Missing required secrets`; `app publish --help` exit 0;
    `app publish -e rd8check` → missing `publishingToken`. No `NotCapable`.
- Blockers: None.
