# `kixx.js admin` — Administration

Commands for bootstrapping the root admin account, minting Publishing API
tokens, and running data migrations against a deployment's Admin API. See
[configuration.md](configuration.md) for `--environment` and `--origin`,
which every sub-command below shares.

## Credentials

No admin credential is ever written to a file or passed through argv. Every
command below prompts interactively, with password entry echo-suppressed.
Set these environment variables to skip the corresponding prompt for
non-interactive or scripted use:

- `KIXX_ADMIN_EMAIL`
- `KIXX_ADMIN_PASSWORD`
- `KIXX_ADMIN_INVITE_TOKEN`

When a value is needed, its environment variable is unset, and stdin is not a
terminal, the command fails immediately naming that variable rather than
blocking.

No admin credential — email, password, or invite token — is ever stored in
`.kixx/secrets.json`. That file holds only the publishing token minted by
`create-publishing-token`.

## Bootstrap the first admin

1. Generate a strong, secret token:

   ```sh
   kixx.js admin gen-secure-token
   ```

2. Configure it as `ADMIN_BOOTSTRAP_TOKEN` in the deployment.
3. Redeem it once to create the root admin:

   ```sh
   kixx.js admin accept-invite -e production
   ```

4. Mint a publishing credential and store it in `.kixx/secrets.json`:

   ```sh
   kixx.js admin create-publishing-token -e production
   ```

5. Remove `ADMIN_BOOTSTRAP_TOKEN` from the deployment.

The bootstrap token is single-use: its consumption is recorded even while the
environment value remains configured, so leaving it configured after step 3
does not allow a second redemption. Removing it in step 5 is still good
practice — a spent value configured in a deployment is a needless secret.

## `gen-secure-token`

Generates a 256-bit secure token encoded as lowercase hexadecimal text,
suitable for `ADMIN_BOOTSTRAP_TOKEN` or any other secret this CLI does not
otherwise create for you.

```sh
kixx.js admin gen-secure-token [--prefix text]
```

`--prefix` prepends a literal string to the random token body.

## `accept-invite`

Redeems a one-time admin invite or bootstrap token and creates the admin
account it grants.

```sh
kixx.js admin accept-invite -e production
```

Prompts for the invite token, the new account's email address, and its
password (entered twice; mismatched entries fail locally before any request is
sent). The password must be 16 to 256 characters — checked locally, because a
server-side rejection would not consume the invite but there is no reason to
make the operator discover that by failing remotely.

On success, prints the created account's id, email address, and creation
date — never the password. An unknown, expired, revoked, or already-used token
renders as an operator-facing message rather than a raw protocol error.

## `create-publishing-token`

Mints a bearer token for the Publishing API, authenticating as an existing
admin.

```sh
kixx.js admin create-publishing-token -e production \
  [--roles editor] [--ttl 2592000] [--description text]
```

`--roles`, `--ttl`, and `--description` are optional and match the API's
defaults (`editor`, 30 days, no description).

The minted plaintext token is printed once, in a clearly labeled block stating
that it cannot be retrieved again, and naming
`app.environments.<environment>.publishingToken` in `.kixx/secrets.json` as
its destination. The command writes it nowhere; the operator copies it in by
hand.

## `list-migrations`

Lists every migration registered in the deployed build, in registry order,
with its status and, for a failed migration, its error message.

```sh
kixx.js admin list-migrations -e production
```

## `run-migration`

Runs one bounded batch of a migration. **One invocation runs exactly one
batch** — the operator owns the loop and repeats the command until the printed
`done` is `true`.

```sh
kixx.js admin run-migration -e production <id> \
  [--dry-run] [--force] [--cursor value] [--yes]
```

To safely apply a migration:

1. List migrations and select a `pending` or intended `failed` migration.
2. Dry-run batches from no cursor until `done` is `true`, carrying each
   returned `--cursor` forward:

   ```sh
   kixx.js admin run-migration -e production <id> --dry-run
   kixx.js admin run-migration -e production <id> --dry-run --cursor <cursor>
   ```

3. Review the dry-run stats.
4. Submit real-run batches — with no `--cursor`, since the server owns
   real-run progress — until `done` is `true`:

   ```sh
   kixx.js admin run-migration -e production <id>
   ```

5. Run `list-migrations` again and confirm `status: applied` with the
   accumulated stats.

`--cursor` is only meaningful together with `--dry-run`; passing it with a
real run is a usage error rather than a silently ignored argument. Before
issuing a real (non-dry-run) batch, the command echoes the resolved
environment name and origin, guarding against a stale `--environment` value.

**When to use `--force` — and when not to.** `--force` restarts an applied or
failed real run from the beginning, resetting its cursor, accumulated stats,
batch count, start identity, and timestamps — information the server cannot
reconstruct. Use it only to deliberately rerun an applied migration or to
restart one whose ledger cursor has become invalid. Because of that
irreversibility, `--force` prompts for a typed confirmation naming the
migration id and environment; pass `--yes` to skip the prompt for scripted
use. Passing both `--dry-run` and `--force` is a usage error.

Three distinct conflicts can stop a real run, and their correct next actions
differ:

| Error | Meaning | Next action |
| --- | --- | --- |
| Already applied | Running an applied migration without `--force` | Pass `--force` to rerun it deliberately |
| Cursor conflict | The stored ledger cursor is invalid; the run is now failed | Restart it with `--force` |
| Concurrency conflict | Another operator advanced the migration first | Run `list-migrations` and retry **without** `--force` |
