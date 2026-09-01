# Roll back application content

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
`app assign-build` with reason `rollback`; a concurrent pointer change stops
the operation. Origin and token come from the standard environment settings
and may be overridden with `--origin` and `--token`.
