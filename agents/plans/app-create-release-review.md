# `app create-release` Review Tracker

Review date: 2026-09-01

Scope: `kixx.js app create-release`, environment resolution, content scanning,
object diff/upload, Release creation, and result rendering. Findings are ordered
by severity. No build-assignment behavior was observed in this flow.

## CR-1: Comment stripping can change JavaScript behavior

**Severity:** High

**Status:** Completed

**Trigger**

Place a JavaScript file under `static-assets/` where a comment separates two
tokens without surrounding whitespace. For example:

```javascript
globalThis.result = typeof/* separator */missingName;
```

`stripJavaScriptComments()` deletes the comment outright and produces:

```javascript
globalThis.result = typeofmissingName;
```

**Implications**

The Release contains code with different behavior from the checked-in source.
The transformed program may remain syntactically valid, so the scanner reports
no problem and the defect reaches the created Release. Other token pairs can
instead produce invalid JavaScript.

**Suggested fix**

Make removal preserve token boundaries. Replace each comment with whitespace
when its adjacent characters could form a different token, while preserving
line terminators where automatic semicolon insertion can depend on them. Parse
the transformed output as a secondary safety check. Add regression cases for
keyword/identifier merging, punctuator merging, and line-terminator-sensitive
statements.

**Evidence**

- `lib/publishing/strip-asset-comments.js:19-23` removes the complete Acorn
  comment ranges.
- `lib/publishing/scan-content-sources.js:311-337` publishes that transformed
  text without reparsing it.

## CR-2: Referenced symlinks can escape the project directory

**Severity:** High

**Status:** Completed

**Trigger**

Create a symlink at a valid path beneath `pages/` or `emails/` whose target is
outside the project, then reference the symlink from `page.json` or
`email.json`. The scanner checks the unresolved path lexically, calls `stat()`,
and reads the symlink target.

A focused reproduction with `pages/linked.txt` pointing to a file outside the
temporary project returned zero validation problems and placed the outside
file's contents in a `PageTemplate` resource.

**Implications**

Running `create-release` on a checkout containing such a symlink can upload and
publish data outside the intended project tree. A committed or locally created
symlink can therefore disclose credentials or other local files to the
configured Publishing API.

**Suggested fix**

Resolve referenced files with `fileSystem.realpath()` before accepting or
reading them, and require the resolved path to remain beneath the resolved
project root. Prefer rejecting symlinked references explicitly if symlinks are
not a supported content convention. Keep the validation and read tied to the
resolved path, and add tests for both outside-project and inside-project
symlinks.

**Evidence**

- `lib/publishing/scan-content-sources.js:546-594` validates the lexical path,
  but `stat()` and `readFile()` follow symlinks.
- `lib/publishing/scan-content-sources.js:688-693` performs only a lexical
  `path.relative()` containment check.
- `lib/file-system.js:37-39` already exposes `realpath()` but the scanner does
  not use it.

## CR-3: An oversized object can cause partial writes before rejection

**Severity:** Medium

**Status:** Open

**Trigger**

Publish at least two missing objects when one exceeds the discovered
`maxObjectBytes` limit. Upload workers start concurrently. The oversized
object is rejected by `uploadObject()`, but another worker can complete a valid
upload before the phase reports failure.

A focused reproduction with a 3-byte server limit, a 5-byte object, and a
2-byte object recorded the small-object upload before the oversized-object
failure.

**Implications**

No Release is created, but objects may be written even though the content tree
was already known to violate the server's size limit. This contradicts the
documented statement that invalid local content fails before network writes,
leaves avoidable inert objects, and can upload data or consume storage during a
command that could have failed before its first write.

**Suggested fix**

After discovery and status resolution, build the deduplicated pending-object
list and validate every payload size against `maxObjectBytes` before starting
any upload worker. Report all oversized source resources in a `UsageError` or a
pre-upload `PublishContentError`. Add a test asserting zero upload calls when
any pending object is oversized.

**Evidence**

- `lib/publishing/publish-content.js:116-125` starts concurrent uploads without
  a complete preflight pass.
- `lib/publishing/publishing-api-client.js:109-125` checks the size only when
  each individual upload has already been dispatched to the client method.
- `docs/app.md:22-23` promises that invalid local content fails before network
  writes.

## CR-4: Unexpected positional arguments are silently ignored

**Severity:** Low

**Status:** Open

**Trigger**

Append any positional argument to the command, for example:

```sh
kixx.js app create-release -e production accidental-value
```

The runner passes the positional to `run()`, but the command declares only the
`options` parameter and ignores the extra value.

**Implications**

A typo or stale invocation can still scan, upload, and create an immutable
Release instead of failing fast. The Release is not assigned to a build, but
the command performs unintended network writes and reports success.

**Suggested fix**

Accept `...positionals` in `run()`, require its length to be zero, and throw a
`UsageError` naming the unexpected arguments otherwise. Add a command test
that asserts the release dependency is not called.

**Evidence**

- `kixx.js:339-346` enables positional parsing for every subcommand.
- `kixx.js:381-390` forwards all parsed positionals to `run()`.
- `commands/app/create-release.js:28-42` ignores arguments after `options`.
- `commands/README.md` states that the runner does not enforce arity and each
  command must validate its own positionals.

## Review validation

- `node run-tests.js test/unit-tests/commands/app test/unit-tests/lib/publishing`
  — 75 existing command, scanner, addressing, client, and publish-pipeline tests
  passed.
- Focused Node reproductions confirmed CR-1, CR-2, and CR-3.
