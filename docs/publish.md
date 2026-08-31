# Publish application content

`kixx.js app publish` publishes a project's pages, templates, static assets,
public files, and emails to a running Kixx application. It updates content for
an existing build without creating or deploying a new Worker version.

## Usage

```sh
kixx.js app publish --environment production
```

Options:

| Option | Meaning |
| --- | --- |
| `--environment`, `-e` | Required environment beneath `app.environments`. |
| `--build-id` | Build to publish. Defaults to the environment's recorded live build. |
| `--bootstrap` | Seed an empty closure before the first publish for a build. |
| `--dry-run` | Scan and stat content without uploading, committing, or writing local state. |
| `--verbose` | List every resource, hash, size, and disposition. |
| `--origin` | Override the configured application origin. |
| `--token` | Override the configured publishing token. The token is never printed. |

## Configuration

Configure the environment origin in `.kixx/config.json`:

```json
{
    "app": {
        "environments": {
            "production": {
                "origin": "https://example.com"
            }
        }
    }
}
```

Configure its bearer token in `.kixx/secrets.json`:

```json
{
    "app": {
        "environments": {
            "production": {
                "publishingToken": "secret"
            }
        }
    }
}
```

`--origin` and `--token` override these values for one invocation. The command
does not print the token, including in verbose output.

Without `--build-id`, the command reads `liveBuildId` from
`.kixx/app-state.<environment>.json`. This file is updated by successful
deployments. For a build not recorded in the checkout, pass its id explicitly.

## Content conventions

The command scans five project directories before making network requests:

- `pages/`: each `page.json` defines the page at its directory pathname. Its
  `template`, `partials`, and `includes` entries name files relative to that
  manifest. Root `pages/page.json` defines `/`.
- `templates/`: files under `templates/partials/` form the global partials
  bundle; files under `templates/base/` form the base-template bundle.
- `static-assets/`: files publish from the application root. JavaScript and CSS
  comments are removed before hashing and upload.
- `public/`: files also publish from the application root, byte-for-byte. A
  pathname colliding with `static-assets/` is an error.
- `emails/`: each `email.json` defines an email bundle. `htmlTemplate`,
  `textTemplate`, and `partials` name sibling files; `contextData` is retained.

Files that match no convention are reported but do not stop publishing.
Invalid manifests, pathnames, missing references, empty static assets, and
collisions are reported together, and no network request is made.

## Publishing pipeline

The command performs three phases:

1. Scan, map, hash, and validate the complete local source tree.
2. Stat each resource against the Publishing API and upload only resources
   whose server-reported hash differs or is absent.
3. Commit the complete content closure under the build id.

The closure commit is the only operation that makes uploaded blobs live. If a
stat or upload fails, the existing closure stays unchanged. Uploaded blobs from
an interrupted attempt are unreferenced and safe to retry.

An unchanged tree uploads nothing but still commits its complete closure. This
reassigns the build pointer and makes republishing or restoring older source
trees deterministic.

### First publish and `--bootstrap`

Resource stat and upload endpoints require an existing content snapshot. For a
new build, publish an empty closure first:

```sh
kixx.js app publish --environment production \
  --build-id 2026-08-31T14-02-11Z --bootstrap
```

Bootstrap skips resource stats, commits the empty closure, uploads every local
resource, then replaces it with the complete closure. If the build already has
a closure, omit `--bootstrap`.

A first Worker deployment must happen before its Publishing API is reachable,
but that deployment initially serves a `BUILD_ID` with no registered closure.
Requests fail during this bootstrap window. Run `cloudflare
create-worker-version --deploy`, then immediately publish the reported build id
with `--bootstrap` as shown above.

## Output

Default output names the environment, origin, build id, resource counts,
uploaded resources, unmatched files, closure hash, node count, and written
state file. `--verbose` additionally lists every resource with its hash, size,
and whether it matched or uploaded.

A successful commit records its closure hash and timestamp in
`.kixx/app-state.<environment>.json`. A failed publish and a dry run do not
write that file. Dry-run output labels resources that would upload and states
that no remote or local writes occurred.
