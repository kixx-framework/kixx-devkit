# Configuration

Settings shared by the `app`, `cloudflare`, and `admin` commands: the `.kixx`
layering, `--environment`, and the environment and Cloudflare settings each
command family reads.

## The `.kixx` two-layer merge

Settings live in a `.kixx` directory at two scopes: the user home directory
and the project directory (discovered by walking up from the working
directory). The project layer is merged over the home layer, so shared
credentials are written once in the home directory while each project only
records what differs.

```
~/.kixx/config.json                  <- home layer, general settings
~/.kixx/secrets.json                 <- home layer, secrets
<project>/.kixx/config.json          <- project layer, general settings
<project>/.kixx/secrets.json         <- project layer, secrets
```

A missing `.kixx` directory or a missing file yields an empty layer. Both
merged results are deeply frozen before a command runs.

## `--environment`

Every `app` and `admin` command, and every `cloudflare` command except
`create-worker`, takes a required `--environment` (`-e`) option naming one key
under `app.environments` in `.kixx/config.json`:

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

A missing `--environment` fails with a usage error before any network call.

## Publishing API settings

`app` commands and the Publishing API side of `admin create-publishing-token`
read:

- `app.environments.<environment>.origin` in `.kixx/config.json` — the
  published application's origin.
- `app.environments.<environment>.publishingToken` in `.kixx/secrets.json` —
  the bearer token minted by `admin create-publishing-token`.

```json
// .kixx/config.json
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

```json
// .kixx/secrets.json
{
    "app": {
        "environments": {
            "production": {
                "publishingToken": "kxpat_..."
            }
        }
    }
}
```

Both accept `--origin` and `--token` overrides on the commands that use them.
A missing setting fails with a usage error naming the file and the exact key
path.

## Cloudflare settings

`cloudflare` commands read Cloudflare account credentials from
`.kixx/secrets.json`:

```json
{
    "cloudflare": {
        "accountId": "...",
        "apiToken": "..."
    }
}
```

The API token must be able to inspect and create Workers, Worker versions, and
any D1 database or KV namespace whose ID is not yet configured.

Worker and version settings live in the project's `cloudflare-config.js`, keyed
by environment name under `environments`. See [cloudflare.md](cloudflare.md)
for its shape.
