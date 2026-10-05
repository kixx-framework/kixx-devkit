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
  so no published user ever migrates config formats.
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

**Status:** Not started
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

- [ ] `grep -rn "from 'kixx-assert'" lib commands test kixx.js run-tests.js`
      returns nothing.
- [ ] The full test suite passes with `node_modules/kixx-assert` deleted.
- [ ] Lint is clean.

**Validation**

- `rm -rf node_modules/kixx-assert && node run-tests.js` — proves nothing
  resolves the npm copy.
- `npm run lint`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RD-2: Run the project toolchain on Deno, with Node release verification

**Status:** Not started
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

- [ ] From a clean checkout with no `node_modules/`, `deno task check`,
      `deno task lint`, and `deno task test` pass.
- [ ] `deno task test:node` runs the full suite on Node and passes.
- [ ] `deno task test test/unit-tests/lib` and `--skip <path>` behave as
      `node run-tests.js` did.
- [ ] `deno task kixx` with no arguments prints the command list and exits
      `1`. `deno task kixx admin gen-secure-token` exits `0`.
- [ ] Developer docs tell the reader to use `deno task`, not `npm`.

**Validation**

- `rm -rf node_modules && deno task check && deno task lint && deno task test`
- `deno task test:node`
- `deno task kixx; echo $?` — help, then `1`.
- `grep -rn "npm run\|node run-tests" README.md AGENTS.md test/README.md agents/docs`
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

### Task RD-3: Replace the filesystem command registry with static imports

**Status:** Not started
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

- [ ] `grep -rn "readdir\|import.meta.url\|pathToFileURL" lib/command-registry.js kixx.js`
      returns nothing.
- [ ] Help at every level (`kixx.js`, `kixx.js app --help`,
      `kixx.js app publish --help`) is byte-identical to the output before
      this task, except for intentional ordering decisions recorded in the
      handoff notes.
- [ ] Unknown command and unknown sub-command produce the same messages and
      exit code `1` as before.
- [ ] The conformance test passes, and fails if a sub-command file is not
      registered (check this by temporarily removing one entry).
- [ ] `deno task check`, `deno task lint`, `deno task test`, and
      `deno task test:node` pass.

**Validation**

- Capture help output before the change into the agent scratchpad:
  `for c in "" admin app cloudflare; do deno task kixx $c --help; done > <scratchpad>/before.txt`,
  plus one sub-command `--help` per command. Repeat after the change and
  `diff`.
- `deno task test test/unit-tests/commands`
- `deno task check && deno task lint && deno task test && deno task test:node`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RD-4: Rename the program to `kixx` and add `--version`

**Status:** Not started
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

- [ ] `grep -rn "kixx\.js" lib commands docs README.md` returns only
      references to the source file.
- [ ] `deno task kixx --version` and `deno task kixx -v` print `0.1.0` and
      exit `0`. So does `node kixx.js --version`.
- [ ] Top-level help lists `--version`.
- [ ] Tests cover `--version` and the updated strings. All tasks pass.

**Validation**

- `deno task kixx -v; echo $?` and `node kixx.js --version`
- `grep -rn "kixx\.js" lib commands docs README.md`
- `deno task check && deno task lint && deno task test && deno task test:node`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RD-5: Define the npm and JSR package contents

**Status:** Not started
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

- [ ] `npm pack --dry-run` lists only `kixx.js`, `commands/**`, `lib/**`,
      `deno.json`, `README.md`, `LICENSE`, and `package.json`.
- [ ] `deno publish --dry-run` succeeds, its file list matches the
      intended set, and its only warnings are the accepted ones.
- [ ] The consistency test passes, and fails when either version is changed
      alone.

**Validation**

- `npm pack --dry-run`
- `deno publish --dry-run`
- `deno task test test/unit-tests/manifests.test.js`

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RD-6: Verify installed executables and document installation

**Status:** Not started
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

- [ ] Both installed executables pass every check above.
- [ ] No `NotCapable` error under `-RWNE --allow-sys=homedir --no-prompt`.
- [ ] README install instructions match what was tested.

**Validation**

- The install and run commands above, with output recorded in handoff notes.
- `deno task check && deno task lint && deno task test && deno task test:node`
  if code changed.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RD-7: Add the tag-triggered release workflow

**Status:** Not started
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

- [ ] The workflow file is valid YAML and the logic matches the steps above.
- [ ] The skip checks work, verified locally against the registries for an
      existing package version and a nonexistent one, e.g. `curl` the JSR
      meta URL and `npm view` for a known package.
- [ ] README documents the release procedure.

**Validation**

- `actionlint .github/workflows/release.yml` if the user has it installed;
  otherwise a YAML parse, e.g. `deno eval` with `jsr:@std/yaml`, plus review.
  Do not install tools without asking.
- Manual run of the skip-check commands.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.

---

### Task RD-8: Publish 0.1.0 to npm and JSR

**Status:** Not started
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
- User steps, in order:
  1. On jsr.io: create `@kixx/devkit` in the `@kixx` scope and link it to
     `kixx-framework/kixx-devkit`.
  2. From a clean checkout of the release commit, run local validation, then
     `npm publish --access public` with their account (2FA). npm trusted
     publishing can only be configured on an existing package. This first
     publish has no provenance.
  3. On npmjs.com: add a trusted publisher for the repository and
     `release.yml`.
  4. Push tag `v0.1.0`. The workflow skips npm (already published) and
     publishes JSR.
- Later releases use only step 4, after bumping versions.

**Expected touch points**

- None in the repository, unless the README needs corrections found during
  verification.

**Acceptance criteria**

- [ ] `npm view kixx-devkit@0.1.0` and `https://jsr.io/@kixx/devkit/meta.json`
      show 0.1.0.
- [ ] `npm install -g --prefix <scratch> kixx-devkit` and
      `deno install -g --root <scratch> -RWNE --allow-sys=homedir jsr:@kixx/devkit/kixx`
      both install an executable named `kixx` that prints `0.1.0` for
      `--version`. The Deno install works without `--name`.
- [ ] The RD-6 command checks pass on both registry installs.

**Validation**

- The install commands above, into the scratchpad.
- The release workflow run log shows JSR published and npm skipped.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: Requires the user's registry accounts.
