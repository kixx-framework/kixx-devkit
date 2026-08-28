Kixx Devkit Commands
====================

How the CLI in `kixx.js` discovers, configures, and runs commands, and what you
need to write to add a new one.


Command Structure
-----------------

Every invocation names two things:

```
kixx.js <command> <subcommand> [options] <...args>
```

The first argument is a **command**: a directory under `commands/`. The second
is a **sub-command**: a `.js` module inside that directory. `commands/` is the
whole registry — there is no list to register into, no import to add. Creating
the files is what makes the command exist.

```
commands/
    admin/
        index.js              <- command metadata
        gen-secure-token.js   <- sub-command implementation
    cloudflare/
        index.js
        create-worker.js
```

`lib/command-registry.js` reads the directory to list commands, imports
`<command>/index.js` for the descriptions used in help output, and imports
`<command>/<subcommand>.js` to get the class it runs.


The Command Index Module
------------------------

`index.js` carries only metadata. It exports `description` (used when listing
top level commands) and `subcommands`, a map keyed by sub-command file basename:

```js
export const description = 'Application administration tools';

export const subcommands = {
    'gen-secure-token': {
        description: `
            Generate a 256-bit secure token encoded as lowercase hexadecimal
            text, suitable for things like the ADMIN_BOOTSTRAP_TOKEN
        `,
    },
};
```

Descriptions are re-wrapped to the help line width, so the indentation of a
template literal is irrelevant.

The `subcommands` map is the source of truth for descriptions. Each sub-command
module imports its own entry rather than restating the text, which keeps the
listing and the `--help` output from drifting apart.

A sub-command file missing from this map still runs; it just lists with an
empty description. A map entry with no matching file lists but fails to
resolve. Keep the two in sync.


The Sub-command Module
----------------------

A sub-command module default-exports a class. Static properties declare
everything the runner needs to know *before* constructing it — help text,
argument parsing rules, and required settings — so a command never runs
partially configured.

```js
import process from 'node:process';
import { subcommands } from './index.js';

export default class GenSecretTokenCommand {

    static description = subcommands['gen-secure-token'].description;

    static options = {
        prefix: {
            type: 'string',
            short: 'p',
            description: 'Optional literal prefix prepended to the random token body',
        },
    };

    run(options) {
        const token = generateSecretToken(options.prefix);
        process.stdout.write(`${ token }\n`);
        return 0;
    }
}
```

### Static properties

**`description`** — Sentence or paragraph shown by `--help`. Import it from
`./index.js`.

**`options`** — Passed straight to `node:util` `parseArgs` as its `options`
config, so `type` (`'string'` or `'boolean'`), `short`, `multiple`, and
`default` all behave as documented there. The extra `description` key is used
only for help rendering. `--help` is added automatically; do not declare it.
Negated boolean flags (`--no-foo`) are enabled for command options.

**`positionals`** — Array of `{ name, description, required }` used to build
the usage line and the `Arguments:` section of help. `required: false` renders
the name in square brackets. This is documentation only: the runner does not
enforce arity, so validate positionals inside `run()` and throw a `UsageError`
when they are wrong.

**`requiredConfig`** — Dotted key paths which must be present in the merged
`.kixx/config.json` layers.

**`requiredSecrets`** — Dotted key paths which must be present in the merged
`.kixx/secrets.json` layers.

**`requiredCloudflareConfig`** — Dotted key paths which must resolve to
non-empty strings in the project's `cloudflare-config.js`. Only loaded and
checked for sub-commands of the `cloudflare` command.

Each check runs before construction. A missing value aborts with a message
naming the command, the missing key paths, and the files they belong in.

### Constructor

The runner constructs the class with a single object:

```js
constructor(args) {
    const { projectDirectory, cloudflareConfig, config, secrets } = args ?? {};
}
```

- `projectDirectory` — Directory owning the `.kixx` directory, discovered by
  walking up from the working directory. Falls back to the working directory
  when no project is found.
- `config` — Deeply frozen merge of `~/.kixx/config.json` and
  `<project>/.kixx/config.json`, project layer last.
- `secrets` — Same merge for `secrets.json`.
- `cloudflareConfig` — Default export of the project's `cloudflare-config.js`,
  or `undefined` for any command other than `cloudflare`.

Commands which need no injected state can omit the constructor entirely.

### run()

```js
async run(options, ...positionals) {}
```

`options` is the parsed flag values; the rest are positional arguments. Return
an integer to set the process exit code — `0` for success. A non-integer return
leaves the exit code alone, which also means success.

Write results to `process.stdout`. Throw `UsageError` (from
`lib/usage-error.js`) for anything the user can fix by changing arguments or
settings: the runner prints its message alone, with no stack trace. Any other
error prints `Failed to run command:` followed by the full error, which is what
you want for a genuine defect. Both exit with code `1`.


Adding a New Command
--------------------

To add a sub-command to an existing command:

1. Create `commands/<command>/<subcommand>.js` default-exporting the class.
2. Add a matching entry to the `subcommands` map in
   `commands/<command>/index.js`.

To add a new top level command, also create the directory and its `index.js`
exporting `description` and `subcommands`.

Then verify:

```
node kixx.js                            # the command lists
node kixx.js <command> --help           # the sub-command lists
node kixx.js <command> <subcommand> --help
node kixx.js <command> <subcommand>     # the real thing
npm run lint
```

Shared logic belongs in `lib/`, not in a command module. A command should read
as the wiring between parsed arguments, loaded settings, and a library call —
`commands/cloudflare/create-worker.js` is the model: it constructs an API
client from secrets, makes one call, prints the result, and returns.
