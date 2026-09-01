# Cloudflare create-worker

`kixx.js cloudflare create-worker` creates the Worker named by one Cloudflare
environment configuration. It does not package, upload, or deploy a Worker
version.

## Usage

```sh
kixx.js cloudflare create-worker --environment production
```

`--environment` (`-e`) is required and selects
`environments.<environment>.WORKER` in `cloudflare-config.js`. The command
requires `cloudflare.accountId` and `cloudflare.apiToken` in
`.kixx/secrets.json`.

After creation, use `cloudflare create-worker-version` to upload an undeployed
version, or use `cloudflare release` to stage application content and deploy a
version as one release workflow.
