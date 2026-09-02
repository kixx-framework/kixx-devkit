`kixx.js app publish` Review Tracker
====================================

Reviewed: 2026-09-02

Scope
-----

The review traced `kixx.js app publish` through environment and build
resolution, source scanning, object status and upload, Release creation, and
build-pointer assignment. It also reviewed the related command and publishing
unit tests.

Severity meanings:

- **High:** Can publish unintended data or materially violate the command's
  safety contract.
- **Medium:** Causes a failed or misleading publish with recoverable remote
  side effects.
- **Low:** Accepts invalid operator input but does not corrupt remote state.

Summary
-------

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| APP-PUBLISH-1 | High | Source-directory symlinks can publish files outside the project | Open |
| APP-PUBLISH-2 | Medium | An empty page template fails only after the upload phase starts | Open |
| APP-PUBLISH-3 | Medium | Assignment failures hide the Release created by the same command | Open |
| APP-PUBLISH-4 | Low | Unexpected positional arguments are silently ignored | Open |


APP-PUBLISH-1: Source-directory symlinks can publish files outside the project
-----------------------------------------------------------------------------

**Severity:** High

**Trigger**

Make one of the five publishing roots (`pages/`, `templates/`,
`static-assets/`, `public/`, or `emails/`) a symbolic link. `#walkFiles()`
calls `readDirectory()` on the root without first applying the symlink check
used for referenced files. Node follows that root symlink. Regular files in
the target are then read and represented as if they were inside the project.

A symlink encountered *below* a real root has the opposite failure mode:
`Dirent.isDirectory()` and `Dirent.isFile()` are both false, so lines 687-692
of `lib/publishing/scan-content-sources.js` silently skip it. It appears in
neither `problems` nor `unmatchedFiles`.

**Implications**

- A root symlink can upload files outside the project. This crosses the
  scanner's project boundary and can disclose unintended content to the
  Publishing API.
- A nested symlink can silently omit expected content while the command
  reports a clean scan and creates a Release without it.
- The behavior contradicts the scanner's explicit rejection of symlinks in
  referenced-file paths at lines 565-575.

The root case was reproduced with `public` linked to a temporary directory
outside the project. The scanner returned its `secret.txt` as a `StaticAsset`,
with no problem or unmatched-file entry.

**Suggested fix**

- Define one policy for symlinks across roots, traversed entries, and manifest
  references. The existing referenced-file policy suggests rejecting them.
- Use `lstat()` before walking each source root and report a validation problem
  when the root is a symlink.
- Detect `entry.isSymbolicLink()` during traversal and report it rather than
  silently continuing.
- If following symlinks is desired instead, resolve every candidate with
  `realpath()`, prove it remains below the real project root, and prevent
  directory cycles.
- Add scanner tests for top-level and nested symlinked files and directories.


APP-PUBLISH-2: An empty page template fails only after uploads start
-------------------------------------------------------------------

**Severity:** Medium

**Trigger**

Reference a zero-byte template from `pages/**/page.json`. The scanner accepts
the file and creates a zero-byte `PageTemplate` resource at lines 123-169 of
`lib/publishing/scan-content-sources.js`. Source validation therefore succeeds.

After discovery and the object-status request, `publishContent()` starts the
concurrent upload queue at lines 117-130. The real client then rejects the
template locally because `uploadObject()` requires `size > 0` at line 126 of
`lib/publishing/publishing-api-client.js`.

**Implications**

- A locally invalid source is reported as an upload-phase internal failure,
  not as a source validation error.
- Other objects in the six-wide upload batch may already have been written
  before the empty template is rejected. No Release or pointer is created,
  but the documented guarantee that invalid local content fails before
  network writes is broken.
- Dry-run does not expose the problem because it returns before pending-object
  validation.

This was reproduced with `pages/page.json` referencing an empty `page.html`.
The scan had no problems; the real client failed with
`PublishContentError`, phase `upload`, and `uploadObject() body must not be
empty`.

**Suggested fix**

- Confirm whether Publishing API v1 permits empty objects.
- If it does not, make the scanner add an `empty-page-template` problem before
  constructing the resource. Also add a general pending-object preflight so
  no unsupported payload can enter the concurrent upload queue.
- If it does, remove the client's `size > 0` assertion and add protocol tests
  for a zero-byte object.
- Cover real and dry-run behavior with scanner and publish-pipeline tests.


APP-PUBLISH-3: Assignment failures hide the created Release
------------------------------------------------------------

**Severity:** Medium

**Trigger**

Let object upload and Release creation succeed, then make build assignment
fail. Examples include an ETag conflict, a network failure, a missing Release,
or an invalid build assignment.

`commands/app/publish.js` receives the Release result at lines 46-51, awaits
assignment at lines 53-60, and writes all output only at lines 62-67. Any
assignment error skips the output containing `result.releaseId`.

**Implications**

- The command exits as a failure without telling the operator that immutable
  content was successfully created.
- The Release id needed for the natural recovery command,
  `app assign-build --release-id <id>`, is hidden.
- Operators may rerun the full scan/upload/create flow or incorrectly assume
  no remote state was written. Content idempotence limits damage, but the
  failure report is operationally incomplete.

**Suggested fix**

- Catch assignment failures at the composition boundary and enrich them with
  the Release id, build id, and a concise recovery command.
- Prefer a dedicated error carrying the Release result over printing an
  ordinary success summary before assignment completes.
- Add command tests for conflict and generic assignment failures, asserting
  that the Release id is present and success is not claimed.


APP-PUBLISH-4: Unexpected positional arguments are silently ignored
-------------------------------------------------------------------

**Severity:** Low

**Trigger**

Run the command with an extra positional, for example:

```sh
kixx.js app publish --environment production accidental-value
```

The runner allows positionals, and `AppPublishCommand.run(options)` neither
receives nor validates them.

**Implications**

The publish proceeds despite malformed input. A mistyped value that an
operator expects the command to reject can therefore accompany a real build
pointer update.

**Suggested fix**

- Reject every positional for this command with a `UsageError` before
  environment resolution or network access.
- Consider enforcing declared positional arity centrally in `kixx.js`, since
  the command guide currently leaves that validation to every command.
- Add a command test proving an extra positional performs no scan or network
  operation.


Validation
----------

- `node run-tests.js test/unit-tests/commands/app test/unit-tests/lib/publishing`
  — passed 82 tests with 0 disabled tests.
- Manual temporary-directory reproductions confirmed APP-PUBLISH-1 and
  APP-PUBLISH-2 without changing repository source files.

