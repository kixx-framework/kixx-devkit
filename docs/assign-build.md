# Assign a Release to a build

`kixx.js app assign-build` changes one build pointer to an existing Release.

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
