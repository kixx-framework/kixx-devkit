# Implementation Plan: JSONC Cloudflare Config and Deno Single Executable

> **Status:** DK-2 and DK-3 are ready to implement once RD-2 in
> `remote-cli-distribution.md` lands. They are prerequisites of RD-8 (first
> public release). DK-4 is a future phase. Do not start it until
> `remote-cli-distribution.md` is complete.
>
> Revised after the remote CLI distribution planning. The former DK-1 (Deno
> toolchain) was absorbed by RD-2. The filesystem command registry DK-4
> assumed is replaced by RD-3.

## Implementation Approach

Replace the executable `cloudflare-config.js` with a data file,
`cloudflare-config.jsonc`, parsed by `jsonc-parser`. Later, ship the devkit
as one self-contained `kixx` executable built with `deno compile`.

Why Deno instead of a Go rewrite: the CSS parser, bundler, content
addressing, and API clients are already tested JavaScript whose output must
match the server byte for byte, and Deno runs this codebase almost unchanged.
Probes done while planning (Deno 2.8.1, macOS arm64):

- `deno run -A run-tests.js` — all 622 tests pass, same as Node.
- `deno run -A run-linter.js` — clean, same as Node.
- `deno compile --no-check -A --include commands kixx.js` — 73 MB binary.
  Help, `admin gen-secure-token`, and a `cloudflare` command ran from inside
  `tmp/sample-app`. That probe used the old filesystem registry; RD-3's static
  registry needs no `--include`.
- Without `--no-check`, compile failed only on `TS2307: Cannot find module
  'kixx-assert'` (3 sites). RD-1 vendors `kixx-assert`, which removes this.

Why JSONC instead of JS config: the CLI will later write provisioned resource
IDs back into the config file. Writing safely into executable JS requires AST
editing and fails when values are computed. JSONC keeps comments for authors
and supports minimal-edit writes (`jsonc-parser` `modify` + `applyEdits`).
Writing is deferred; this plan only parses. Converting before the first
public release means no published user ever migrates config formats.

The Worker still needs the config as a JS module. The packager generates a
virtual `cloudflare-config.js` module (`export default {...};`) from the
parsed JSONC, so the application's `cloudflare-server.js` keeps
`import sourceConfig from './cloudflare-config.js'` unchanged.

Cross-cutting decisions:

- **Toolchain and conventions.** As set in `remote-cli-distribution.md`: Deno
  tasks (`deno task check|lint|test|test:node|kixx`), plain JS with `node:`
  built-ins, no `Deno.*` APIs, the CLI named `kixx`, no runtime package
  dependencies.
- **Dependencies.** The user approved `jsonc-parser@3.3.1`, vendored into
  `lib/vendor/jsonc-parser/` like `kixx-assert`. No registry pin, so both
  packages stay free of runtime dependencies. Add nothing else without
  asking.
- **CLI compatibility.** Command names, flags, positionals, exit codes, and
  output wording stay the same. Config locations (`~/.kixx`,
  `<project>/.kixx`, `.env` files, `example.env.secrets`, state files) are
  unchanged.
- **State hashes.** Byte-identical `modulesHash` across the switch is not
  required. The generated config module changes module content, so each
  environment uploads one new version on its first post-migration build.
  `configHash` and `bindingsHash` are unaffected. Document this.
- **Out of scope:** Node.js app deployments and `node-config.js` (the app
  template's `node-server.js` lives in another repo); writing to JSONC; Linux
  and Windows binaries (DK-4 is macOS only); CI and release automation for
  binaries; macOS notarization.

Tasks and dependencies:

```
RD-2 (remote-cli-distribution.md) ── DK-2 JSONC config loader ── DK-3 Generated Worker config module ── RD-8
RD-6 (remote-cli-distribution.md) ── DK-4 Compiled `kixx` binary (future phase)
```

---

### Task DK-2: Load `cloudflare-config.jsonc` instead of `cloudflare-config.js`

**Status:** Not started
**Depends on:** RD-2 (`remote-cli-distribution.md`)
**Documentation:** `docs/cloudflare.md`; `docs/configuration.md`;
`commands/README.md`

**Objective**

`cloudflare` commands read their configuration from
`<project>/cloudflare-config.jsonc`. The parsed object has the same shape the
JS module's default export had, so all downstream code is unchanged. The
devkit no longer executes project code to read configuration.

**Scope**

- In: vendoring `jsonc-parser`, the loader, its error reporting, the
  legacy-file guard, help labels, docs, tests, and converting
  `tmp/sample-app` locally for manual checks.
- Out: providing the config to the Worker (DK-3); writing to the file
  (future); `node-config.js`.

**Design and invariants**

- Vendor `jsonc-parser@3.3.1` into `lib/vendor/jsonc-parser/`, following
  RD-1's layout for `kixx-assert`:
  - Copy the ESM build (`lib/esm/main.js` and `lib/esm/impl/*.js`, keeping
    the `impl/` subdirectory) and `LICENSE.md`. Skip the UMD build and
    `main.d.ts`.
  - The upstream ESM build uses extensionless relative imports
    (`from './impl/format'`), which Node and Deno both reject. Append `.js`
    to each relative import (9 lines across `main.js`, `impl/edit.js`,
    `impl/format.js`, `impl/parser.js`). This is the only modification.
    Verified during planning: `parse`, `modify`, and `applyEdits` then work
    on Node 24 and Deno 2.8.
  - `lib/vendor/jsonc-parser/README.md` records the upstream version, URL,
    and the import-extension patch, so a future upgrade reapplies it.
  - Get the files from the npm tarball (`npm pack jsonc-parser@3.3.1` into
    the agent scratchpad). Do not add it to any manifest.
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

- `lib/vendor/jsonc-parser/**` — new, vendored.
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

**Status:** Not started (future phase)
**Depends on:** RD-6 and all of `remote-cli-distribution.md`; DK-2
**Documentation:** `README.md`; `commands/README.md`; `docs/*.md`

**Objective**

`deno task compile` produces self-contained `kixx` executables for
darwin-arm64 and darwin-x64. A user needs neither Node.js nor Deno installed.

**Scope**

- In: macOS-only compile tasks, baked-in permissions, `dist/` output,
  binary install and build documentation.
- Out: Linux and Windows builds, CI, GitHub Release automation,
  signing/notarization. The program name and `--version` are already done
  (RD-4).

**Design and invariants**

- Targets and outputs (in gitignored `dist/`):
  - `aarch64-apple-darwin` → `dist/kixx-darwin-arm64`
  - `x86_64-apple-darwin` → `dist/kixx-darwin-x64`
- The static command registry (RD-3) puts every command in the module graph.
  Do not pass `--include commands`.
- Compile with type checking on (no `--no-check`).
- Permissions are baked in at compile time. Use the set RD-6 verified for
  `deno install`: `-RWNE --allow-sys=homedir`. A difference between binary
  and installed-script permissions needs the user's agreement.
- After DK-2, the CLI reads `cloudflare-config.jsonc` as data, so the binary
  never imports project code.
- `kixx --version` in the binary prints the `deno.json` version (JSON import,
  embedded at compile time).
- Interactive prompts (`lib/prompt.js` masked input via raw mode) must work
  in the compiled binary on macOS.

**Expected touch points**

- `deno.json` — `compile` task building both macOS targets, and a
  `compile:local` task for the host platform.
- `.gitignore` — `dist/`.
- `README.md` — build and binary install instructions (copy the binary onto
  `PATH`; macOS quarantine note for downloaded binaries).

**Acceptance criteria**

- [ ] `deno task compile` writes both macOS binaries without `--no-check`.
- [ ] On the host binary: no-arg help exits 1; `--help` at every level exits
      0; `--version` prints the version; `admin gen-secure-token` prints a
      token; a `cloudflare` command run in a project directory loads `.kixx`
      and `cloudflare-config.jsonc`.
- [ ] Masked prompt works in the compiled binary
      (`admin accept-invite` against a non-routable origin, aborting after the
      prompts).
- [ ] The darwin-x64 binary runs `--help` (natively on Intel, or under
      Rosetta 2 via `arch -x86_64`).

**Validation**

- `deno task compile && ls -lh dist/`
- `./dist/kixx-darwin-arm64; echo $?` — help, `1`.
- `./dist/kixx-darwin-arm64 --version`
- From `tmp/sample-app`: `../../dist/kixx-darwin-arm64 cloudflare
  deploy-version -e production` — expect the Publishing API configuration
  usage error (proves config loading, no network write).
- `arch -x86_64 ./dist/kixx-darwin-x64 --help` — requires Rosetta 2.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: Planning probe showed a 73 MB darwin-arm64
  binary.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
