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

The command reads the current pointer and uses its ETag for compare-and-swap.
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
