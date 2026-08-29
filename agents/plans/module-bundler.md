# Implementation Plan: JavaScript Module Bundler

## Implementation Approach

Build a target-agnostic ES module bundler at `lib/bundler/`. Given the filepath of
a root module, it crawls the static import graph, strips comments from every
module, and returns a data structure that a deployment target can turn into an
upload payload.

The central design choice is that **this bundler does not link or concatenate**.
Both intended targets accept multiple ES modules — Cloudflare through the Workers
version upload (see `lib/cloudflare/cloudflare-worker-version.js`, whose
`addModule()` already owns the `main_module` invariant), and AWS Lambda through
zip entries. Concatenation would require scope hoisting, identifier renaming,
export linking, and cycle-safe TDZ handling: the hardest part of a bundler,
solving a problem neither target has. Emitted modules therefore keep their import
statements **verbatim**. No specifier is ever rewritten.

That decision makes the module key a runtime contract rather than a label. Keys
are `./`-prefixed POSIX paths relative to the base directory, and the target
runtime resolves each module's relative specifiers against its key. Because the
key namespace mirrors the source tree exactly, unmodified specifiers resolve
correctly by construction.

Cross-cutting concerns:

- **The base directory is `dirname(entryFilepath)` and is inviolable.** Every
  module must live inside it, so that every module has a representable key.
- **All filesystem access goes through an injected interface.** The bundler
  never imports `node:fs/promises` outside `file-system.js`. This follows the
  code style guide's rule that filesystem abstractions are low-level adapters to
  be separated from general-purpose code, and it lets tests supply a mock
  without patching a Node builtin globally.
- **Problems are collected, not thrown at first sight.** A graph of 231 modules
  with three bad imports should take one build to diagnose, not three. Every
  check produces a diagnostic; the crawl continues over everything still
  reachable; a single `BundleError` carrying all diagnostics is thrown at the end.
- **Determinism.** The entry is inserted first, then modules are inserted in
  depth-first order following each module's import statements in source order.
  A `Map` preserves insertion order, so repeated builds are byte-identical.
- **One parse per module.** A single acorn pass yields both the import AST and
  the comment ranges. Parsing twice would double the cost of the whole build.

### Public API

```js
import bundleModules from './lib/bundler/bundle-modules.js';

const bundle = await bundleModules({
    entryFilepath: '/Users/kris/Projects/app/cloudflare-server.js',
    externals: [ 'node:', 'cloudflare:' ],
});

// bundle.entry   -> './cloudflare-server.js'
// bundle.modules -> Map<string, { name, source }>
```

### Rejection rules

Every one of these produces a diagnostic rather than an immediate throw:

| Condition | Example |
| --- | --- |
| Bare specifier not matching `externals` | `lodash` |
| Resolved path contains a `node_modules` segment (logical or real) | `./vendor/x.js` symlinked into `node_modules` |
| Resolves outside the base directory | `../../shared/util.js` |
| Not an exact existing file | `./logger`, `./kixx/logger` |
| Extension is not `.js` or `.mjs` | `./legacy.cjs`, `./data.json`, `./styles.css` |
| Real path differs from logical path only by letter case | `./kixx/Logger/logger.js` |
| `import()` with a non-literal argument | `import(pluginPath)` |
| Module fails to parse | any syntax error |

### Decisions already settled

Recorded here so no later agent re-opens them:

- No concatenation, no linker, no tree shaking, no minification beyond comment
  removal, no source maps.
- No specifier rewriting of any kind.
- Keys carry the `./` prefix.
- Comments are replaced by the number of newlines they spanned, so emitted line
  numbers match the source file and a production stack trace stays truthful
  without a source map.
- JavaScript only. `.cjs`, `.json`, and every other extension are errors.
  Non-JS assets are the concern of a separate static-asset delivery path.
- Scope stops at the generic bundler. No Cloudflare adapter and no deploy
  command are part of this work.
- Acorn's hashbang handling needs no special case: the tokenizer skips a leading
  hashbang silently (`lib/vendor/acorn/src/state.js:80`) and never reports it to
  `onComment`, so it passes through untouched and line 1 is preserved.
- `import.meta` is not a dependency edge and is left alone.

### Known limitation

The case-mismatch check treats a path whose real path differs by more than case
as a symlink and allows it. A path that is *both* symlinked and miscased will
therefore not be reported as miscased. This is accepted: detecting it would
require comparing the true casing segment by segment across a symlink boundary,
for a case that has not been observed.

---

### Task 1: Diagnostic contract and BundleError

**Status:** Complete
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`

**Objective**

A single error type carries every problem found during a build, and a single
documented object shape describes one problem. Every other module in the bundler
produces diagnostics in this shape, so this task defines the vocabulary the rest
of the implementation speaks.

**Scope**

- In: `lib/bundler/bundle-error.js` — the `BundleError` class, the `Diagnostic`
  typedef, and the formatting that turns a diagnostic list into the error message.
- Out: producing diagnostics (Tasks 3, 4, 5); any filesystem or parsing concern.

**Design and invariants**

- `BundleError extends Error` and follows the shape established by
  `lib/usage-error.js`: `name` and `code` are defined from `this.constructor.name`
  as enumerable own properties. This is what lets `kixx.js:398`-style top-level
  handlers branch on the error without importing the class.
- The constructor takes the diagnostic array and builds the message from it. The
  array is exposed on the instance so a programmatic caller can inspect it rather
  than parse the message.
- Store a copy of the diagnostics array, not the caller's reference, so later
  caller-side mutation cannot change an error that has already been thrown.
- A diagnostic is a plain object, not a class. It carries no behavior and the
  style guide rejects thin wrappers over data. Document it with a `@typedef`.
- Diagnostic fields: `importer` (module key, or `null` for a problem with the
  entry itself), `specifier` (the specifier text, or `null` for a whole-module
  problem such as a parse failure), `line`, `column`, and `message` (a complete
  human sentence explaining the problem).
- The message lists every diagnostic, grouped so the reader can scan it. The
  first line states the count.
- Identical diagnostics are deduplicated before formatting. The same bad
  specifier reached from two importers is two distinct diagnostics and both are
  kept; only exact duplicates collapse.

**Expected touch points**

- `lib/bundler/bundle-error.js` — new module.
- `test/unit-tests/lib/bundler/bundle-error.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] `BundleError` sets `name` and `code` to `'BundleError'` as enumerable own
      properties, matching the `UsageError` pattern.
- [ ] The diagnostics array is reachable on the instance and is not the same
      object reference the caller passed in.
- [ ] The message names the total count and includes the importer, line, and
      specifier for each diagnostic.
- [ ] Exact duplicate diagnostics appear once in the message.
- [ ] A diagnostic with a `null` importer (an entry-level problem) formats
      without printing `null`.
- [ ] The `Diagnostic` typedef documents every field.

**Validation**

- `node run-tests.js test/unit-tests/lib/bundler/bundle-error.test.js`
- `npm run lint`
- Unit tests cover: field exposure, defensive copying, message formatting for
  one and for many diagnostics, deduplication, and the null-importer case.

**Progress and handoff**

- Completed: Implemented BundleError with Diagnostic typedef, defensive diagnostic array copy, duplicate-free message formatting, and focused tests.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: The established UsageError pattern uses enumerable own name and code properties via Object.defineProperties(). Duplicate diagnostics are suppressed only in the human-readable message; the exposed diagnostics array retains every collected problem.
- Actual files changed: `lib/bundler/bundle-error.js`, `test/unit-tests/lib/bundler/bundle-error.test.js`, `agents/plans/module-bundler.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/bundler/bundle-error.test.js` passed (4 tests); `node run-linter.js lib/bundler/bundle-error.js test/unit-tests/lib/bundler/bundle-error.test.js` passed; `npm run lint` was attempted but fails on pre-existing vendored Acorn sources under `lib/vendor/acorn/`.
- Blockers: None.

---

### Task 2: Filesystem interface and default adapter

**Status:** Complete
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md` (separate low-level adapters from general-purpose code), `test/README.md`

**Objective**

All filesystem access the bundler performs is expressed as three named
operations behind one injectable interface, with a default implementation over
`node:fs/promises`. No other module in `lib/bundler/` imports `node:fs/promises`.

**Scope**

- In: `lib/bundler/file-system.js` — the `FileSystem` typedef and the default
  adapter.
- Out: every caller of the interface (Tasks 4 and 5).

**Design and invariants**

- The interface is defined by what the bundler needs, not by what
  `node:fs/promises` offers. Exactly three operations:
  - `readFile(filepath)` resolves to the file's contents decoded as UTF-8. The
    adapter owns the encoding choice so no caller passes `'utf8'` around.
  - `realpath(filepath)` resolves to the fully resolved absolute path, with
    symlinks followed and the true on-disk letter casing applied. This one call
    serves both the node_modules laundering check and the case-mismatch check.
  - `isFile(filepath)` resolves to a boolean.
- `isFile()` deliberately returns a boolean rather than exposing `stat()`. A
  `Stats` object in the interface would force every mock to fake one; a boolean
  makes a mock a one-line function. It also keeps the abstraction at the level
  of the question actually being asked.
- `isFile()` resolves to `false` for a missing path rather than rejecting.
  "Does not exist" and "exists but is a directory" are the same answer to the
  caller — the module cannot be bundled — and both produce the same diagnostic,
  so collapsing them at the adapter keeps `try`/`catch` out of the resolver.
  Errors that are not about absence (`EACCES`, for instance) must propagate;
  swallowing a permissions failure as "not found" would produce a misleading
  diagnostic.
- The default adapter is a frozen plain object of functions, not a class. It
  holds no state and a class would be exactly the thin wrapper the style guide
  rejects.
- Export the default adapter as the module default so `bundle-modules.js` can
  use it as the fallback for the `fileSystem` option.

**Expected touch points**

- `lib/bundler/file-system.js` — new module.
- `test/unit-tests/lib/bundler/file-system.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] The module exports a default adapter providing `readFile`, `realpath`,
      and `isFile`.
- [ ] `readFile()` returns a string, with UTF-8 decoding owned by the adapter.
- [ ] `isFile()` returns `true` for a file, `false` for a directory, and
      `false` for a missing path.
- [ ] `isFile()` propagates an error that is not about the path's absence.
- [ ] A `FileSystem` typedef documents the interface so injected mocks have a
      written contract to satisfy.
- [ ] No module under `lib/bundler/` other than this one imports
      `node:fs/promises`.

**Validation**

- `node run-tests.js test/unit-tests/lib/bundler/file-system.test.js`
- `npm run lint`
- `grep -rn "node:fs" lib/bundler/` returns only `file-system.js`.
- Unit tests exercise the adapter against a real temporary directory, since this
  module is precisely the boundary that a mock cannot verify. Cover the
  directory case, the missing-path case, and error propagation.

**Progress and handoff**

- Completed: Added the frozen default FileSystem adapter and real-filesystem contract tests.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: isFile() treats ENOENT and ENOTDIR as false, while invalid path input propagates its TypeError. Full-project lint fails on pre-existing vendored Acorn sources; scoped lint verifies changed files.
- Actual files changed: `lib/bundler/file-system.js`, `test/unit-tests/lib/bundler/file-system.test.js`, `agents/plans/module-bundler.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/bundler/file-system.test.js` passed (3 tests); `node run-linter.js lib/bundler/file-system.js test/unit-tests/lib/bundler/file-system.test.js` passed; `rg -n "node:fs" lib/bundler/` returned only `file-system.js`.
- Update (create-worker-version Task 1): the adapter moved to `lib/file-system.js`
  and its test to `test/unit-tests/lib/file-system.test.js`, gaining `writeFile`,
  so it can also serve the Cloudflare worker version modules. `lib/bundler/`
  imports it via `../file-system.js`.
- Blockers: None.
- Blockers: None.

---

### Task 3: Parse and strip comments

**Status:** Complete
**Depends on:** None
**Documentation:** `agents/docs/code-style-guide.md`, `lib/vendor/acorn/index.js`, `lib/vendor/acorn/src/options.js`

**Objective**

One function parses a module's source with the vendored acorn, returns the AST,
and returns the source with every comment removed and every line number
unchanged. It touches no filesystem and knows nothing about bundling.

**Scope**

- In: `lib/bundler/strip-comments.js` — the single parse pass and the comment
  excision.
- Out: import extraction (Task 5 walks the returned AST); reading files; any
  notion of a module graph.

**Design and invariants**

- One acorn `parse()` call produces both outputs. Parsing twice would double
  the cost of the whole build for no benefit.
- Parse options: `ecmaVersion: 'latest'`, `sourceType: 'module'`,
  `ranges: true`, `locations: true`, and `onComment` set to an array. Acorn
  accepts an array for `onComment` and pushes comment objects into it
  (`lib/vendor/acorn/src/options.js:137`), so no callback is required.
  `locations: true` is what gives diagnostics real line and column numbers.
- `ranges: true` puts `start` and `end` on each collected comment object; those
  offsets index the original source string directly.
- Excision rule: for each comment, count the `\n` characters in the removed text
  and emit exactly that many `\n` in its place. A line comment contains none and
  collapses to nothing. A three-line block comment leaves two newlines. Every
  line number after the comment is therefore unchanged, which is the entire
  point — a stack trace from a deployed Worker must still point at the right
  line of the original source file.
- Column positions within a line may shift when a block comment sits between
  code on one line. This is accepted; lines are what stack traces report.
- Build the result by walking the comment ranges in ascending order and
  concatenating the slices between them. Do not mutate the string repeatedly
  from the front, which would invalidate every subsequent offset.
- Acorn returns comment ranges in source order already, but sort defensively
  before splicing; the excision is only correct on an ordered list.
- A syntax error propagates as acorn's own `SyntaxError`. `lib/vendor/acorn/index.js`
  already normalizes it to carry `lineNumber` and `column`, which is exactly
  what a diagnostic needs. Do not catch it here — the caller decides whether a
  parse failure aborts or becomes a diagnostic.
- The hashbang needs no handling. The tokenizer skips it and never reports it as
  a comment (`lib/vendor/acorn/src/state.js:80`), so it survives untouched.

**Expected touch points**

- `lib/bundler/strip-comments.js` — new module.
- `test/unit-tests/lib/bundler/strip-comments.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Returns both the AST and the stripped source from a single parse.
- [ ] Line comments, block comments, and JSDoc blocks are all removed.
- [ ] The stripped source has the same number of lines as the input, and code on
      line N in the input is on line N in the output.
- [ ] A comment-like sequence inside a string literal, a template literal, or a
      regular expression literal is untouched. Acorn's tokenizer guarantees
      this, and a test must pin it.
- [ ] A leading hashbang survives unchanged and line 1 is preserved.
- [ ] Source with no comments is returned unchanged.
- [ ] A syntax error propagates with `lineNumber` and `column` set.
- [ ] The stripped source still parses.

**Validation**

- `node run-tests.js test/unit-tests/lib/bundler/strip-comments.test.js`
- `npm run lint`
- Unit tests use plain source strings; this module needs no filesystem at all.
- A test that strips a fixture string, re-parses the output, and asserts it
  parses — proving excision never leaves broken syntax behind.
- A test asserting line-number preservation by locating a known statement's
  line before and after.

**Progress and handoff**

- Completed: Added a single-pass Acorn parser that returns the AST and line-preserving comment-stripped source, with focused tests.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: Despite the plan's prior expectation, the vendored Acorn release reports a leading hashbang through onComment. The implementation filters that one comment so the required hashbang preservation holds. The vendored source cannot pass this project's lint configuration, so scoped lint verifies changed files.
- Actual files changed: `lib/bundler/strip-comments.js`, `test/unit-tests/lib/bundler/strip-comments.test.js`, `agents/plans/module-bundler.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/bundler/strip-comments.test.js` passed (6 tests); `node run-linter.js lib/bundler/strip-comments.js test/unit-tests/lib/bundler/strip-comments.test.js` passed.
- Blockers: None.

---

### Task 4: Specifier classification and resolution

**Status:** Complete
**Depends on:** Task 1, Task 2
**Documentation:** `agents/docs/code-style-guide.md`, `test/README.md`

**Objective**

One function decides what a single import specifier means: an external left
untouched, an internal module with a bundle key and an absolute filepath, or a
diagnostic explaining why it cannot be bundled. Every rejection rule in this
plan is enforced here, in one place.

**Scope**

- In: `lib/bundler/resolve-specifier.js` — specifier classification, path
  resolution, key derivation, and all seven specifier-level rejection rules.
- Out: walking the AST to find specifiers, and the crawl itself (Task 5);
  the computed-`import()` rejection, which is an AST-shape problem detected in
  Task 5 before a specifier string even exists.

**Design and invariants**

- Return a discriminated result rather than throwing: `external`, `internal`, or
  `error`. Throwing would force the caller into `try`/`catch` for a routine,
  expected outcome, and the collect-all error model needs the crawl to keep
  going past a bad edge.
- Cheap checks run before expensive ones. Classification, extension, base-directory
  containment, and the logical `node_modules` check are all pure string work and
  run first. Only a specifier that survives all of them costs filesystem calls.
- Order of checks:
  1. **Classify.** A specifier starting with `./` or `../` is relative. Anything
     else is bare. A bare specifier is matched against `externals`: an entry
     ending in `:` matches as a prefix, any other entry matches exactly. A match
     returns `external`; a miss returns an error diagnostic. This is the
     specifier half of the node_modules prohibition — a bare specifier can only
     ever resolve through `node_modules`.
  2. **Resolve.** Join the specifier to the importer's directory and normalize.
  3. **Extension.** Only `.js` and `.mjs`. `.cjs` gets its own message saying
     CommonJS is not supported, because that is a different mistake from
     importing a `.json` file and deserves a different explanation.
  4. **Containment.** The resolved path must be inside the base directory.
     Compare on a normalized path with a trailing separator so that a sibling
     directory sharing a name prefix is not mistaken for a child.
  5. **Logical node_modules.** Reject any resolved path with a `node_modules`
     path segment. Split on the separator and compare segments; a substring
     search would falsely reject a directory legitimately named
     `my_node_modules_helper`.
  6. **Existence.** `isFile()` must be true. False covers both a missing file
     and a directory, and both mean the same thing to the caller.
  7. **Real path.** Call `realpath()`, then apply two checks to the result. If
     it contains a `node_modules` segment, reject — this is the laundering case
     where a directory inside the base is a symlink into `node_modules`. If it
     differs from the logical path but is equal when lowercased, reject as a
     case mismatch and name the true on-disk casing in the message. A path
     differing in any other way is an ordinary symlink and is allowed.
- The key is derived from the **logical** path, never the real path. A symlink
  must not move a module within the bundle namespace.
- Key format: `./` followed by the path relative to the base directory, with
  separators normalized to `/`. Derive POSIX separators explicitly rather than
  relying on the host; a Windows build must produce the same keys as a macOS one.
- The case check is the reason `realpath()` exists in the interface, and it is
  the only defense against a class of bug that is invisible on the developer's
  case-insensitive macOS filesystem and fatal on the case-sensitive deploy target.

**Expected touch points**

- `lib/bundler/resolve-specifier.js` — new module.
- `test/unit-tests/lib/bundler/resolve-specifier.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] A bare specifier matching an `externals` prefix entry (`node:`) or an
      exact entry returns `external` and is never resolved or read.
- [ ] A bare specifier not matching `externals` returns a diagnostic.
- [ ] `externals` defaults to an empty list, making every bare specifier an
      error unless explicitly permitted.
- [ ] A valid relative specifier returns the `./`-prefixed key and the absolute
      filepath.
- [ ] Keys use `/` separators regardless of host platform.
- [ ] `.cjs` is rejected with a CommonJS-specific message; other non-JS
      extensions are rejected with an unsupported-type message.
- [ ] An extensionless specifier and a directory specifier are both rejected.
- [ ] A path escaping the base directory is rejected, and a sibling directory
      sharing a name prefix with the base is not mistaken for a child.
- [ ] A `node_modules` segment is rejected in the logical path and in the real
      path; a directory named `my_node_modules_helper` is not rejected.
- [ ] A path whose real path differs only by case is rejected, and the message
      names the true on-disk casing.
- [ ] A path whose real path differs by more than case is accepted as a symlink
      and is keyed by its logical path.
- [ ] No filesystem call is made for a specifier rejected by a string-level check.

**Validation**

- `node run-tests.js test/unit-tests/lib/bundler/resolve-specifier.test.js`
- `npm run lint`
- Tests inject a mock `FileSystem` built from a file-local object literal, per
  the `test/README.md` preference for file-local helpers. A local
  `makeFileSystem(files)` helper returns the three-function interface over a map
  of absolute path to contents, with a separate map for real-path overrides so
  the symlink and case-mismatch cases are one entry each.
- A test asserting that a string-rejected specifier triggers zero calls on the
  mock, using `mock.callCount()` to pin the cheap-checks-first ordering.

**Progress and handoff**

- Completed: Added the injected-filesystem resolver and tests for external, internal, missing, containment, node_modules, casing, and symlink outcomes.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: Internal names are derived from the logical path, while realpath is used only for laundering and case validation. Full-project lint remains blocked by pre-existing vendored Acorn violations; scoped lint verifies changed files.
- Actual files changed: `lib/bundler/resolve-specifier.js`, `test/unit-tests/lib/bundler/resolve-specifier.test.js`, `agents/plans/module-bundler.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/bundler/resolve-specifier.test.js` passed (9 tests); `node run-linter.js lib/bundler/resolve-specifier.js test/unit-tests/lib/bundler/resolve-specifier.test.js` passed.
- Blockers: None.

---

### Task 5: Graph crawl and public API

**Status:** Complete
**Depends on:** Task 1, Task 2, Task 3, Task 4
**Documentation:** `agents/docs/code-style-guide.md`, `agents/docs/code-documentation-guide.md`, `test/README.md`

**Objective**

`bundleModules()` takes an entry filepath and returns the finished bundle: the
entry key and a `Map` of every reachable module keyed by bundle name, each
carrying its comment-stripped source. A graph with any problem throws one
`BundleError` listing all of them.

**Scope**

- In: `lib/bundler/bundle-modules.js` — the public function, option handling and
  defaults, entry validation, AST import extraction, the depth-first crawl,
  cycle handling, diagnostic accumulation, and the final throw.
- Out: everything owned by Tasks 1–4; any deployment-target adapter.

**Design and invariants**

- Signature is `export default async function bundleModules(args)`, taking one
  options object and destructuring inside the body, per the style guide and the
  precedent set by `loadConfiguration()` in `lib/config-loader.js`.
- Options: `entryFilepath` (required), `externals` (defaults to an empty array),
  and `fileSystem` (defaults to the Task 2 adapter). The `fileSystem` default
  means normal callers pass two options and tests pass three.
- The base directory is `dirname(entryFilepath)` and is computed once. The entry
  key is always `'./'` plus the entry's basename, so the entry is always at the
  root of the key namespace.
- The entry is validated by the same rules as any other module: it must exist,
  be a file, and carry a `.js` or `.mjs` extension. An entry-level problem
  produces a diagnostic with a `null` importer.
- Import extraction walks only the top level of the AST body for
  `ImportDeclaration`, `ExportNamedDeclaration` with a non-null `source`, and
  `ExportAllDeclaration`. These cannot be nested, so no recursive walk is needed
  for them.
- `ImportExpression` **can** be nested anywhere an expression is legal, so it
  requires a recursive walk of the AST. An `ImportExpression` whose `source` is
  a `Literal` with a string value is an ordinary edge. Any other `source` — an
  identifier, a template literal, a concatenation — is a diagnostic, because a
  computed specifier is unanalyzable and cannot work on a runtime with no
  filesystem. Report it at the expression's own line.
- Write the recursive walk against the AST directly rather than adding a walker
  dependency. Nothing may be installed for this work.
- The crawl is depth-first: read and parse a module, then process its
  dependencies in source-statement order, recursing into each internal one
  before moving to the next. The entry is inserted into the `Map` first.
  Insertion order is the emit order, and it is deterministic because statement
  order is fixed by the source.
- Cycles terminate through the `Map` itself: a module whose key is already
  present is never re-read. ES modules legitimately contain cycles and this must
  not be treated as an error. Insert the module's record **before** recursing
  into its dependencies, or a cycle will recurse forever.
- The crawl is serial. A 231-module graph is not worth a concurrency limiter,
  and serial recursion is what makes the insertion order trivially deterministic.
- A parse failure is a diagnostic like any other, carrying the module's key and
  the line and column from acorn's normalized `SyntaxError`. The module's
  dependencies cannot be discovered, so that subtree is abandoned while the rest
  of the crawl continues.
- The module record is `{ name, source }` and nothing more. `name` duplicates
  the `Map` key so a record passed around alone still identifies itself.
- Throw only after the crawl completes. If the diagnostics list is non-empty,
  throw `BundleError`; otherwise return the bundle.

**Expected touch points**

- `lib/bundler/bundle-modules.js` — new module.
- `test/unit-tests/lib/bundler/bundle-modules.test.js` — new test file.

Treat this list as orientation, not permission to ignore other necessary files.
Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Returns `{ entry, modules }` where `entry` is the `./`-prefixed entry key
      and `modules` is a `Map` keyed by module name.
- [ ] The entry is the first entry in the `Map`, and iteration order is
      depth-first discovery order.
- [ ] Two builds of the same graph produce identical key order and identical
      sources.
- [ ] Every module's source has its comments stripped and its line numbers
      preserved.
- [ ] Import statements in emitted sources are byte-identical to the source
      file's, modulo comment removal. Nothing is rewritten.
- [ ] `import`, `export ... from`, and `export * from` all create edges. The
      sample app depends heavily on re-exports, so all three must be pinned.
- [ ] `import()` with a string literal creates an edge; `import()` with any
      other argument produces a diagnostic naming its line.
- [ ] A nested `import()` inside a function body is found.
- [ ] A cyclic graph terminates and contains each module once.
- [ ] A diamond graph reads each shared module once.
- [ ] External specifiers are preserved in the source and never resolved.
- [ ] A graph with several distinct problems throws one `BundleError` whose
      diagnostics list contains all of them.
- [ ] A parse failure in one module does not prevent the rest of the graph from
      being crawled and reported.
- [ ] A missing, non-file, or wrong-extension entry produces a diagnostic with a
      `null` importer.
- [ ] `externals` defaults to an empty array and `fileSystem` defaults to the
      real adapter.

**Validation**

- `node run-tests.js test/unit-tests/lib/bundler`
- `npm test` — linter and the full suite, proving nothing else regressed.
- Tests inject a mock `FileSystem` over a file-local object literal describing
  each graph, per Task 4's helper pattern. No test patches `node:fs/promises`.
- Manual check that cannot be expressed as a unit test: run the bundler against
  the sample app at `tmp/app/cloudflare-server.js` with
  `externals: [ 'node:', 'cloudflare:' ]`. Confirm it completes without
  diagnostics, that the entry key is `./cloudflare-server.js`, and that the
  module count and total stripped size are plausible against the 231 files and
  1.5 MB of source measured during planning. `tmp/` is gitignored, so this is a
  one-off check and never a committed fixture.

**Progress and handoff**

- Completed: Added the public module graph crawl with deterministic depth-first ordering, cycle handling, static and dynamic dependency discovery, aggregate diagnostics, and graph-level tests.
- Current state: Complete.
- Remaining: Nothing.
- Decisions and discoveries: A separate visited set prevents re-reading parse-invalid modules while the module Map preserves successful module insertion order. The sample app currently bundles 201 modules totaling 746342 stripped source bytes, rather than the earlier planning estimate. Full-project lint remains blocked by pre-existing vendored Acorn violations; scoped lint verifies changed files.
- Actual files changed: `lib/bundler/bundle-modules.js`, `test/unit-tests/lib/bundler/bundle-modules.test.js`, `agents/plans/module-bundler.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/bundler` passed (28 tests); `node run-linter.js lib/bundler test/unit-tests/lib/bundler` passed; `node run-tests.js` passed (97 tests); `git diff --check` passed; manual sample-app bundle completed with entry `./cloudflare-server.js`, 201 modules, and 746342 source bytes. `npm test` was attempted but exits 1 before tests because lint reports pre-existing errors throughout `lib/vendor/acorn/`.
- Blockers: None.
