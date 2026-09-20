# `kixx.js app` — Content Releases

Commands for creating, assigning, and rolling back application content through
the Publishing API. See [configuration.md](configuration.md) for
`--environment`, the origin, and the publishing token these commands share.

## Server requirement

These commands require a deployment serving build assignment protocol 2 and
addressing format 4. Every command that writes reads the server's capabilities
first and refuses an older deployment before uploading an object, creating a
Release, or touching a build pointer. There is no fallback to the earlier
header-based assignment protocol.

A refusal names each mismatch and the value this tool supports. The resolution
is to upgrade the deployment or target one that is already upgraded.

## `create-release`

Scans and uploads application content and creates an immutable Release without
reading or changing any build pointer.

```sh
kixx.js app create-release -e production [--dry-run] [--verbose] \
  [--message text] [--source-revision revision]
```

`--origin` and `--token` override the standard environment settings. The
optional message and source revision are non-binding provenance.

Dry-run performs authenticated discovery and object-status checks, but no
upload, validation, Release creation, or build assignment. Its output contains
no Release id and labels the result as an unvalidated preview. Invalid local
content fails before network writes; upload failure prevents Release creation.

## `assign-build`

Changes one build pointer to an existing Release.

```sh
kixx.js app assign-build -e production \
  --build-id build-id --release-id release-id [--reason publish]
```

`--reason` accepts the server's audit reasons: `publish` (default), `rollback`,
`carry-forward`, or `restore`. `--origin` and `--token` override the standard
environment settings.

The command reads the build pointer and sends the `assignmentId` it observed
as the write's precondition. That identity is opaque and server-generated: it
is copied verbatim and never derived from a Release id. A build that has never
been assigned is written with an explicit empty precondition, which is how a
new build id is bootstrapped.

Output reports the resulting assignment identity. It is the value that ties
this command to an entry in the build's activation history, and the value the
next write will have to quote.

A concurrent pointer change fails with a conflict and is never retried. See
[Pointer conflicts](#pointer-conflicts). This command does not scan, upload,
validate, or create content.

### Pointer conflicts

Every assignment this tool performs is conditional on the identity it read a
moment earlier. When that identity is stale the server refuses the write and
the command stops, reporting what it intended, the identity it expected, and
what the pointer holds now.

Nothing is retried, and the tool never resolves a conflict on its own. A
conflict means something else moved the pointer, so a retry would overwrite
that change — possibly a publish another operator is in the middle of. Read
the build, decide whether that content should still be replaced, and run the
command again only then.

Assignment has no idempotent retry at all. If a command dies without printing
a result, the write may or may not have committed: read the build before
assuming either way.

## `publish`

Creates an immutable content Release and assigns it to a build. It is the
convenience composition of `create-release` and `assign-build`.

```sh
kixx.js app publish --environment production
```

| Option | Meaning |
| --- | --- |
| `--environment`, `-e` | Required environment beneath `app.environments`. |
| `--build-id` | Target build; defaults to authenticated discovery's `runningBuildId`. |
| `--dry-run` | Check stored objects and print an unvalidated, no-write preview. |
| `--verbose` | List every resource, hash, size, and disposition. |
| `--origin` | Override the configured application origin. |
| `--token` | Override the publishing token; it is never printed. |

If discovery reports no running build, pass `--build-id` or create and assign
a Release explicitly.

The command scans `pages/`, `templates/`, `static-assets/`, `public/`, and
`emails/`; validates the complete tree; checks which content-addressed objects
exist; uploads misses; creates a Release; then assigns that Release under the
pointer precondition described in [`assign-build`](#assign-build). A concurrent
pointer change stops assignment rather than overwriting it. Dry-run stops after
the object-status diff and creates or assigns nothing.

Output includes environment, origin, build id, assignment identity, resource
counts, uploaded resources, unmatched files, and the Release id. A dry run
reports no assignment identity because it assigns nothing. No checkout-local
publishing state is read or written.

If the Release is created but the assignment fails, the error reports the
Release id and a ready-to-run `app assign-build` command. The Release already
exists on the server, so recovery is an assignment, not a republish. The
recovery command carries no precondition: `assign-build` observes the current
identity itself when it runs.

### Stylesheet bundling

Every `.css` file under `static-assets/` is published as an entry point. Local
unconditioned `@import` rules are recursively inlined in cascade order, while
each imported library file is also published as its own static asset. Changing
an imported file therefore changes the entry point's content hash. Stylesheets
under `public/` remain verbatim and are not bundled.

Imports may use root-relative paths or paths relative to the importing file.
Targets must remain inside `static-assets/`, use canonical lowercase pathnames,
end in `.css`, and omit query strings and fragments. Relative paths may not
climb above the site root. Missing and invalid targets stop publishing.

External imports (a URL scheme or `//`) stay unchanged. Imports with media,
`supports()`, or `layer` conditions also stay as browser fallbacks; local
conditioned paths are rewritten root-relative and their targets are validated.
All kept imports must precede significant bundled content. This includes rules
inlined by an earlier import.

Repeated imports are inlined at every occurrence. Import cycles are rejected
with the import chain. The entry point keeps a leading UTF-8 `@charset`; charset
rules are removed from inlined files, and other encodings are rejected.

Relative `url()` references are rewritten root-relative from the stylesheet
that contains them, retaining query strings and fragments. Root-relative,
external, data, fragment-only, and empty URLs are unchanged. Relative bare
strings in `image-set()` must instead use `url()`.

Stylesheet validation reports these problem codes:

- `css-import-missing`
- `css-import-invalid`
- `css-import-misplaced`
- `css-import-cycle`
- `css-charset-unsupported`
- `css-url-invalid`

## `rollback`

Inspect recent history without writing:

```sh
kixx.js app rollback -e production --build-id build-id --list
```

Assign an earlier Release:

```sh
kixx.js app rollback -e production --build-id build-id \
  --release-id release-id
```

Pass exactly one of `--list` or `--release-id`. List mode reads recent Releases
and activations only, and writes nothing.

List mode prints each activation as a transition — the Release the build moved
from, the Release it moved to, when, why, and the assignment identity that
recorded it. A first assignment has no predecessor and prints as such. Release
ids print in full so one can be pasted straight back into `--release-id`.

An empty activation history is reported, not treated as an error. Activation
history is best-effort on the server: an assignment that commits can still
lose its history entry, and a no-op assignment records nothing at all. The
build pointer, not the history, is authoritative, and a missing entry never
blocks the next assignment.

Assignment uses the same conditional write as `assign-build`, with reason
`rollback`; a concurrent pointer change stops the operation. See
[Pointer conflicts](#pointer-conflicts). Origin and token come from the
standard environment settings and may be overridden with `--origin` and
`--token`.
