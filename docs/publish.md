# Create and assign application content

`kixx.js app publish` creates an immutable content Release and assigns it to a
build. It is the convenience composition of `app create-release` and
`app assign-build`.

## Usage

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

Configure `app.environments.<environment>.origin` in `.kixx/config.json` and
`app.environments.<environment>.publishingToken` in `.kixx/secrets.json`.
Missing settings name the relevant file and key. If discovery reports no
running build, pass `--build-id` or create and assign a Release explicitly.

The command scans `pages/`, `templates/`, `static-assets/`, `public/`, and
`emails/`; validates the complete tree; checks which content-addressed objects
exist; uploads misses; creates a Release; then compare-and-swap assigns that
Release. A concurrent pointer change stops assignment rather than overwriting
it. Dry-run stops after the object-status diff and creates or assigns nothing.

Output includes environment, origin, build id, resource counts, uploaded
resources, unmatched files, and the Release id. No checkout-local publishing
state is read or written.
