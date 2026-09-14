CSS Import Bundling
===================

Inline local `@import` statements in `static-assets/` stylesheets at publish
time, so a template-linked entry point such as `/stylesheets/stylesheet.css`
is served as one fingerprinted, immutably cached file instead of an entry plus
one revalidating request per imported library file.

Reference application: `tmp/sample-app/src/`. Its `static-assets/stylesheets/`
has `stylesheet.css` (imports six `lib/*.css` files) and `admin.css` (imports
`stylesheet.css` plus two `lib/admin-*.css` files).


Implementation Approach
-----------------------

### Why the scanner, and why no framework change

`lib/publishing/scan-content-sources.js` already turns every file under
`static-assets/` into a `StaticAsset` resource, strips comments from `.css`
and `.js`, and hashes the stripped bytes. `create-release`, `publish`, and
`cloudflare release` all go through it.

The framework's `assetUrl` helper renders `/assets/<hash>/<pathname>` where
`<hash>` is that resource's content hash
(`tmp/sample-app/src/kixx/hyperview/hyperview-service.js`, `#getStaticAssets`).
When the scanner makes the bundled bytes the entry's payload, the fingerprint
covers every inlined file automatically. The framework needs no changes.

Bundling happens in memory. Nothing is written to disk. It is always on, with
no flag or config.

### Agreed decisions

These were settled with the project owner. Do not re-open them.

**Entry points and publishing**

- Every `.css` file under `static-assets/` is an entry point. Its published
  payload is its bundle. A file with no imports, charset, or relative URLs
  publishes exactly as today.
- Every file is still published as its own `StaticAsset`, including files that
  are only ever inlined.
- Browser JavaScript `import` bundling is out of scope.

**Import resolution**

- Specifiers may be root-relative (`/stylesheets/lib/x.css`) or relative
  (`./x.css`, `x.css`, `../x.css`). Relative specifiers resolve against the
  importing file's logical pathname, with URL semantics.
- A logical pathname is `/` + the path relative to `static-assets/`.
  `static-assets/stylesheets/lib/x.css` is `/stylesheets/lib/x.css`. Note that
  the scanner's `StaticAsset` resource `pathname` has no leading slash
  (`stylesheets/lib/x.css`).
- Targets resolve only within `static-assets/`, never `public/`.
- The resolved target must pass `isValidPathname`, end in `.css`, and be a
  scanned static asset. Otherwise it is a problem.
- A specifier with a query string or fragment is a problem. It is not
  stripped.
- A relative specifier that climbs above the site root is a problem, even
  though URL resolution would clamp it.

**Import forms**

| Form | Treatment |
| --- | --- |
| `@import "x";` `@import 'x';` `@import url(x);` `@import url("x");` | Inlined in place |
| External specifier: any `scheme:` or `//…` | Kept verbatim |
| Anything after the URL: media query, `supports()`, `layer`, `layer(…)` | Kept, with a relative specifier rewritten to its root-relative resolved pathname and the condition text unchanged. Its target stays published as a fallback. |
| After other rules in its own file, inside a block, or malformed | Problem |

- `@import` is matched case-insensitively, and never inside strings or
  comments.
- A kept import's target is still validated with the resolution rules above.
  A missing target is a problem.
- Placement: an external or conditioned import is kept only if no
  significant content precedes it in the flattened bundle. Otherwise it is
  `css-import-misplaced`.
  - Significant content is anything other than whitespace, the entry's
    `@charset`, `@layer` statement rules (`@layer a, b;`), and other kept
    imports.
  - Example: an external import in `admin.css` placed after
    `@import "/stylesheets/stylesheet.css";` is misplaced, because the
    stylesheet's rules now precede it.

**Graph edge cases**

- Cycles are `css-import-cycle`. The message shows the import chain
  (`/a.css -> /b.css -> /a.css`).
- A file imported more than once is inlined at every occurrence. This matches
  browser cascade behavior. Do not deduplicate.
- The entry keeps its leading `@charset`, and inlined files have theirs
  removed. Any `@charset` other than UTF-8 (case-insensitive `utf-8`) is
  `css-charset-unsupported`.

**`url()` references**

- In every `static-assets/` CSS file, entry points included, a relative
  `url()` is rewritten to the root-relative pathname it resolves to from the
  logical pathname of the file that contains it. This fixes a production bug:
  a relative URL under `/assets/<hash>/…` is served the entry's blob.
- These stay unchanged:
  - `/…`, `//…`, `scheme:` (`data:`, `https:`), and `#…`
  - empty `url()`
- There is no existence check. The target may live in `public/` or be served
  by a route.
- A resolved URL keeps its query string and fragment (`font.eot?#iefix`).
  Resolution above the root clamps silently, as browsers do.
- A relative bare string inside `image-set()` or `-webkit-image-set()` is
  `css-url-invalid`, not rewritten.
- Fingerprinting `url()` targets is out of scope.

**Reporting**

- A bundled resource's `sourceFiles` is the entry followed by each inlined
  file in first-seen order, without duplicates. Kept imports are not sources.
- Dry-run and `--verbose` output are unchanged.
- Problem codes:
  - `css-import-missing`
  - `css-import-invalid`
  - `css-import-misplaced`
  - `css-import-cycle`
  - `css-charset-unsupported`
  - `css-url-invalid`
- Problems carry positions from the original, uncommented source. `line` is
  1-based and `column` is 0-based, matching the existing `invalid-javascript`
  problem. The message includes the position, because `content-source-report.js`
  prints only `filepath: message`.
- A problem's `filepath` is the project-relative path of the file containing
  the offending text.
- Each problem is reported once, keyed by `code`, `filepath`, `line`, and
  `column`. Entries are processed in scan order, so the first report wins
  deterministically. Placement and cycle problems also carry `entry` and
  `importChain` fields and name both in the message.
- Any problem fails the scan before network writes, as today.

### Cross-cutting invariants

- **No new dependencies.** The CSS scanner is hand-written, following the
  precedent of `stripCssComments` in `lib/publishing/strip-asset-comments.js`.
  It understands only strings, comments, escapes, block nesting, top-level
  at-rule preludes, `url()`, and `image-set()`. It does not parse selectors or
  declarations.
- **Byte stability.** For a CSS file with no `@import`, no `@charset`, and no
  relative URL, the output is byte-identical to `stripCssComments(source)`.
  Unaffected assets keep their current hashes.
- **Determinism.** The same tree produces the same bytes, `sourceFiles`, and
  problem order.
- **No token gluing.** Inlined text must never fuse with adjacent tokens, for
  example by ending with a newline.
- **Filesystem access** stays in the scanner through the injected
  `fileSystem`. The CSS modules are pure functions over strings.

### Module layout

- `lib/publishing/parse-stylesheet.js` (Task A) handles one file.
  - `parseStylesheet(source)` lexes the original source and returns:
    - import statements, with ranges, positions, specifier, form, whether
      conditions follow, and whether significant content precedes them
    - the leading `@charset`
    - `url()` and `image-set()` string references, with ranges and positions
    - comment ranges
    - whether the file has significant content
    - file-local problems
  - A render function takes the source, its parse result, the file's logical
    pathname, and an import replacement callback. It emits the text with
    comments stripped and relative URLs rewritten, and calls the callback in
    place of each import statement.
- `lib/publishing/bundle-stylesheet.js` (Task B) handles the import graph:
  resolution, inlining, kept-import rewriting, flattened placement, cycles,
  charset handling, and `sourceFiles`.
  - Signature:
    `bundleStylesheet({ entryPathname, getStylesheet }) -> { source, sourceFiles, problems }`
  - `getStylesheet(pathname)` returns `{ sourcePath, text }` or `null`.
  - Parse results may be memoized per file.
- `scan-content-sources.js` (Task C) calls the bundler. Static asset scanning
  becomes two passes: collect and validate every `static-assets/` file first,
  then build payloads, bundling `.css` files and stripping `.js` files as
  today.

### Out of scope

- Browser JavaScript bundling.
- Fingerprinting `url()` targets.
- Inlining conditioned or layered imports.
- Framework documentation. Report these to the project owner; they are not
  edited here:
  - `tmp/sample-app/src/kixx/static-assets/README.md` warns against relative
    imports and says production build tooling is not available.
  - `tmp/sample-app/src/docs/frontend-development-guide.md` says the bundler
    is outside the project.


Tasks
-----

### Task A: Parse and render a single stylesheet

**Status:** Complete
**Depends on:** None
**Documentation:** This plan, "Agreed decisions" and "Cross-cutting invariants"; `agents/docs/code-style-guide.md`; `agents/docs/code-documentation-guide.md`; `test/README.md`

**Objective**

A pure module turns one CSS source string into a structural description of
its imports, charset, URL references, and file-local problems. It then renders
the comment-stripped output with relative URLs rewritten and each import
statement replaced by whatever the caller supplies. This is the lexical
foundation. It has no knowledge of other files, so it can be verified on its
own.

**Scope**

- In:
  - `lib/publishing/parse-stylesheet.js`
  - lexing strings, escapes, comments, and block depth
  - recognizing top-level `@import` and `@charset`, and `@layer` statement
    rules for the significant-content rule
  - classifying specifiers and URLs as relative, root-relative, external, or
    fragment
  - rewriting relative `url()`s
  - file-local problems:
    - malformed import → `css-import-invalid`
    - import after significant content or inside a block →
      `css-import-misplaced`
    - non-UTF-8 or non-leading `@charset` → `css-charset-unsupported`
    - relative `image-set()` string → `css-url-invalid`
  - unit tests
- Out:
  - resolving imports against other files, inlining, cycles, and flattened
    placement (Task B)
  - scanner changes (Task C)

**Design and invariants**

- Parse the original source, not comment-stripped text, so positions are
  accurate. `line` is 1-based and `column` is 0-based.
- An `@import` or `@charset` inside a string, comment, or `url()` is not a
  statement.
- A `@charset` that is not the first bytes of the file is ignored by
  browsers. Report it as `css-charset-unsupported`, with a message saying it
  must come first.
- Import prelude grammar: `@import` whitespace, then a string or `url(…)`,
  then optional condition text, then `;`. A missing specifier, unclosed
  string, or missing `;` before a block or end of file is
  `css-import-invalid`. Any non-whitespace condition text marks the import as
  conditioned.
- Relative means not starting with `/` or `#`, not matching
  `^[a-z][a-z0-9+.-]*:` (case-insensitive), and not empty. `//…` counts as
  external.
- URL rewriting resolves with URL semantics against the logical pathname, for
  example `new URL(value, 'http://x' + pathname)`. It emits the pathname plus
  query plus fragment as a quoted `url("…")`, escaping `"` and `\`. Do not
  rewrite root-relative, external, or fragment URLs.
- Byte stability: with no imports, no charset, and no relative URLs, the
  output equals `stripCssComments(source)`.
- The render callback receives the parsed import and returns replacement
  text. Task B decides whether that text is inlined content or a rewritten
  kept statement.

**Expected touch points**

- `lib/publishing/parse-stylesheet.js` — new module.
- `test/unit-tests/lib/publishing/parse-stylesheet.test.js` — new tests.

Treat this list as orientation, not permission to ignore other necessary files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [x] All four import forms are recognized, case-insensitively, with the
  correct specifier and position.
- [x] Import-like text in strings, comments, and `url()` is ignored.
- [x] Conditioned (`screen`, `supports(…)`, `layer`, `layer(…)`) and external
  imports are classified correctly.
- [x] Each file-local problem code is produced with a correct position.
- [x] Relative URLs are rewritten, keeping query and fragment. Root-relative,
  external, `data:`, fragment, and empty URLs are untouched.
- [x] A relative `image-set()` string is `css-url-invalid`, and a
  root-relative one is not.
- [x] Output equals `stripCssComments` for sources without imports, charset,
  or relative URLs, including the existing `strip-asset-comments` test inputs.
- [x] JSDoc on exported functions; lint clean.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/parse-stylesheet.test.js` — parser and renderer behavior.
- `npm run lint` — style.

**Progress and handoff**

- Completed: Added the standalone stylesheet parser and renderer, covering
  import forms and placement, charset validation, URL classification and
  rewriting, image-set validation, comment stripping, source positions, and
  byte stability. Added focused unit coverage for each behavior.
- Current state: Complete.
- Remaining: None for Task A. Task B will consume this module for graph
  resolution and bundling.
- Decisions and discoveries: The public API keeps cross-file resolution out of
  the parser and exposes original-source ranges so Task B can replace imports
  without reparsing. URL tokens containing comment-like bytes remain unchanged
  to preserve the existing comment stripper's byte behavior.
- Actual files changed: `lib/publishing/parse-stylesheet.js`;
  `test/unit-tests/lib/publishing/parse-stylesheet.test.js`;
  `agents/plans/css-import-bundling.md`.
- Validation run: `node run-tests.js test/unit-tests/lib/publishing/parse-stylesheet.test.js`
  (12 passed); `npm test` (459 passed); `git diff --check` (passed).
- Blockers: None.


### Task B: Bundle a stylesheet's import graph

**Status:** Not started
**Depends on:** A
**Documentation:** This plan, "Agreed decisions" and "Cross-cutting invariants"; `agents/docs/code-style-guide.md`; `agents/docs/code-documentation-guide.md`; `test/README.md`

**Objective**

Given an entry pathname and a stylesheet lookup, produce the bundled CSS
text, its `sourceFiles`, and every graph-level problem. This owns every
decision that depends on more than one file. It is verifiable with an
in-memory lookup and needs no filesystem.

**Scope**

- In:
  - `lib/publishing/bundle-stylesheet.js`
  - specifier resolution and validation
  - recursive inlining
  - rewriting kept imports to root-relative
  - flattened placement checks
  - cycle detection with import chains
  - keeping the entry's `@charset` and removing inlined ones
  - building `sourceFiles`
  - carrying Task A's file-local problems through
  - unit tests
- Out:
  - reading files, deduplicating problems across entries, and scanner
    integration (Task C)

**Design and invariants**

- Signature:
  `bundleStylesheet({ entryPathname, getStylesheet }) -> { source, sourceFiles, problems }`.
  - `getStylesheet(pathname)` returns `{ sourcePath, text }` or `null`.
  - Pathnames are logical, with a leading `/`.
- Resolution:
  - Resolve relative specifiers with URL semantics against the importer's
    logical pathname.
  - Then reject, as `css-import-invalid`:
    - a query or fragment
    - climbing above the root, detected before URL clamping
    - failing `isValidPathname`
    - not ending in `.css`
  - A lookup miss is `css-import-missing`.
- Only unconditioned local imports are inlined. External and conditioned
  imports are kept.
  - A conditioned local import has its target validated and its specifier
    rewritten to the resolved root-relative pathname. The condition text is
    unchanged.
  - External imports are not validated.
- Placement: track whether significant content has been emitted in the
  flattened output. A kept import emitted after significant content is
  `css-import-misplaced`, with `entry` and `importChain`. A file-local
  misplacement from Task A is reported as-is.
- Cycles: keep an active import stack. An import of a pathname already on the
  stack is `css-import-cycle`, is not inlined, and carries `importChain`.
- Every occurrence of a repeated import is inlined (decision 5b).
  `sourceFiles` still lists each file once, in first-seen order, entry first,
  as project-relative `sourcePath` values.
- `@charset`: the entry's leading UTF-8 charset stays at the start of the
  output, and inlined files' charsets are removed.
- Problems from files reached through several paths may repeat inside one
  bundle. Deduplicating is Task C's job, but avoid needless repeats where
  memoization naturally prevents them.
- Inlined content must not glue onto adjacent tokens.

**Expected touch points**

- `lib/publishing/bundle-stylesheet.js` — new module.
- `test/unit-tests/lib/publishing/bundle-stylesheet.test.js` — new tests.

Treat this list as orientation, not permission to ignore other necessary files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] The sample app's shape (`admin.css` → `stylesheet.css` → libraries)
  bundles into a flat file with no local `@import`, in source cascade order.
- [ ] Relative and root-relative imports both resolve. Imports in nested files
  resolve against the nested file's pathname.
- [ ] Each `css-import-invalid` case (query, fragment, above root, invalid
  pathname, non-`.css`) and `css-import-missing` is reported.
- [ ] External and conditioned imports are kept. Relative conditioned
  specifiers are rewritten, and a missing conditioned target is a problem.
- [ ] A kept import after inlined content is `css-import-misplaced`, naming
  the entry and chain. One before any content is accepted.
- [ ] Direct and indirect cycles are reported with chains.
- [ ] A diamond import is inlined twice, and `sourceFiles` lists it once.
- [ ] The entry's `@charset` is kept, and inlined charsets are removed.
- [ ] Relative `url()`s in inlined files resolve from their own file, not the
  entry.
- [ ] JSDoc on the exported function; lint clean.

**Validation**

- `node run-tests.js test/unit-tests/lib/publishing/bundle-stylesheet.test.js` — graph behavior.
- `npm run lint` — style.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.


### Task C: Integrate bundling into content scanning and document it

**Status:** Not started
**Depends on:** B
**Documentation:** This plan, "Agreed decisions"; `docs/app.md`; `agents/docs/code-style-guide.md`; `test/README.md`

**Objective**

`scanContentSources` publishes every `static-assets/` stylesheet as its
bundle, with the agreed `sourceFiles` and deduplicated problems. Operators can
read how bundling behaves in `docs/app.md`. This is where the feature becomes
observable to every publishing command.

**Scope**

- In:
  - two-pass static asset scanning in `lib/publishing/scan-content-sources.js`
  - calling `bundleStylesheet` for `.css` files in `static-assets/` only
  - deduplicating problems
  - setting bundled `sourceFiles`
  - scanner tests
  - a "Stylesheet bundling" section in `docs/app.md`
  - removing `stripCssComments` and its tests if nothing references them
    anymore
- Out:
  - `public/`, which keeps its current verbatim behavior
  - JavaScript handling, which keeps its current behavior
  - framework docs, which are listed in the handoff for the project owner

**Design and invariants**

- Pass 1 walks `static-assets/`, validates source paths, and reads bytes. For
  valid `.css` files, it decodes UTF-8 (the scanner's current `TextDecoder`
  behavior) into a lookup keyed by logical pathname.
- Pass 2 iterates in the existing sorted walk order and builds payloads:
  - `.css` → `bundleStylesheet`
  - `.js` → `stripJavaScriptComments`, as today
  - anything else → raw bytes
- The empty-asset and collision checks keep their current behavior. The
  empty check applies to the bundled payload.
- Deduplicate problems by `code`, `filepath`, `line`, and `column` across all
  entries, keeping the first occurrence.
- A bundled resource's `sourceFiles` is the bundle's `sourceFiles`, which
  starts with the entry.
- A files-only-reached-by-inlining asset is still published. It does not
  appear in `unmatchedFiles`, because every `static-assets/` file is matched
  today.
- `public/` CSS is not parsed or bundled.
- Scanner output ordering and non-CSS resources are unchanged.

**Expected touch points**

- `lib/publishing/scan-content-sources.js` — two-pass static asset scan and
  bundling.
- `lib/publishing/strip-asset-comments.js` — remove `stripCssComments` if it
  is no longer referenced.
- `test/unit-tests/lib/publishing/scan-content-sources.test.js` — integration
  tests.
- `test/unit-tests/lib/publishing/strip-asset-comments.test.js` — remove CSS
  cases if the function is removed. Keep equivalent byte-stability
  expectations in the Task A tests.
- `docs/app.md` — "Stylesheet bundling" section.

Treat this list as orientation, not permission to ignore other necessary files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] Scanning a temp project with the sample app's stylesheet layout
  produces:
  - bundled `stylesheets/stylesheet.css` and `stylesheets/admin.css` payloads
    with no local imports
  - hashes that change when any imported file changes
  - `sourceFiles` listing entry-first contributors
- [ ] Library files are still published as their own `StaticAsset` resources.
- [ ] A bad import in a library imported by several entries is reported once.
- [ ] Any CSS problem makes `assertPublishableContentSources` throw before
  publishing.
- [ ] CSS without imports, charset, or relative URLs hashes exactly as before
  (existing scanner tests stay green without changing their expectations).
- [ ] `docs/app.md` documents:
  - entry points
  - resolution rules
  - inlined and kept imports
  - placement
  - cycles, repeats, and charset
  - `url()` rewriting
  - problem codes
- [ ] Full suite and lint pass.

**Validation**

- `node run-tests.js` — full unit suite.
- `npm run lint` — style.
- Manual:
  `node -e "import('./lib/publishing/scan-content-sources.js').then(async (m) => { const r = await m.default('tmp/sample-app/src'); console.log(r.problems); console.log(new TextDecoder().decode(r.resources.find((x) => x.pathname === 'stylesheets/admin.css').payload)); })"`
  — the sample app scans with no problems, and `admin.css` contains no local
  `@import`.

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
