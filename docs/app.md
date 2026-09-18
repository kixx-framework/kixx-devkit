# `kixx.js app` — Content Releases

Commands for creating, assigning, and rolling back application content through
the Publishing API. See [configuration.md](configuration.md) for
`--environment`, the origin, and the publishing token these commands share.

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

The command reads the current pointer and uses its release id as the
compare-and-swap precondition.
For a never-assigned build it uses `If-None-Match: *`. A concurrent change
fails with a conflict and is never blindly retried. This command does not scan,
upload, validate, or create content.

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
exist; uploads misses; creates a Release; then compare-and-swap assigns that
Release. A concurrent pointer change stops assignment rather than overwriting
it. Dry-run stops after the object-status diff and creates or assigns nothing.

Output includes environment, origin, build id, resource counts, uploaded
resources, unmatched files, and the Release id. No checkout-local publishing
state is read or written.

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
and activations only. Assignment uses the same compare-and-swap operation as
`assign-build` with reason `rollback`; a concurrent pointer change stops the
operation. Origin and token come from the standard environment settings and
may be overridden with `--origin` and `--token`.
