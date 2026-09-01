# Create a content Release

`kixx.js app create-release` scans and uploads application content and creates
an immutable Release without reading or changing any build pointer.

```sh
kixx.js app create-release -e production [--dry-run] [--verbose] \
  [--message text] [--source-revision revision]
```

`--origin` and `--token` override
`app.environments.<environment>.origin` in `.kixx/config.json` and
`app.environments.<environment>.publishingToken` in `.kixx/secrets.json`.
The optional message and source revision are non-binding provenance.

Dry-run performs authenticated discovery and object-status checks, but no
upload, validation, Release creation, or build assignment. Its output contains
no Release id and labels the result as an unvalidated preview. Invalid local
content fails before network writes; upload failure prevents Release creation.
