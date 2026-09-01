import process from 'node:process';
import { isUndefined } from 'kixx-assert';

import resolveAdminEnvironment from '../../lib/admin/resolve-admin-environment.js';
import {
    MigrationAlreadyAppliedError,
    MigrationCursorConflictError,
    MigrationConcurrencyError,
} from '../../lib/admin/admin-api-error.js';
import { promptForValue, promptForConfirmation } from '../../lib/prompt.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

export default class AdminRunMigrationCommand {

    static description = subcommands['run-migration'].description;

    static positionals = [
        { name: 'id', description: 'Permanent migration id from list-migrations', required: true },
    ];

    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        origin: { type: 'string', description: 'Override the configured Admin API origin' },
        'dry-run': { type: 'boolean', description: 'Preview one batch without mutating anything' },
        force: { type: 'boolean', description: 'Restart an applied or failed real run from the beginning' },
        cursor: { type: 'string', description: 'Dry-run cursor from a prior batch' },
        yes: { type: 'boolean', description: 'Skip the --force confirmation prompt' },
    };

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options, id) {
        const migrationId = requireValue(id, 'A migration id argument is required');
        const dryRun = options?.['dry-run'] ?? false;
        const force = options?.force ?? false;
        const cursor = options?.cursor;
        const skipConfirmation = options?.yes ?? false;

        if (dryRun && force) {
            throw new UsageError('Pass at most one of --dry-run or --force');
        }
        if (!isUndefined(cursor) && !dryRun) {
            throw new UsageError('--cursor is only meaningful together with --dry-run');
        }

        const email = await (this.#args.promptForValue ?? promptForValue)({
            envVar: 'KIXX_ADMIN_EMAIL',
            label: 'Admin email address',
        });
        const password = await (this.#args.promptForValue ?? promptForValue)({
            envVar: 'KIXX_ADMIN_PASSWORD',
            label: 'Admin password',
            mask: true,
        });

        const connection = (this.#args.resolveAdminEnvironment ?? resolveAdminEnvironment)({
            environment: options?.environment,
            config: this.#args.config,
            origin: options?.origin,
            email,
            password,
            createClient: this.#args.createClient,
        });

        if (force && !skipConfirmation) {
            // --force destroys the cursor, stats, batch count, and start
            // identity/timestamps of an applied or failed run, none of which
            // the server can reconstruct. Every other path here needs no
            // prompt; adding one would just train the operator to click
            // through it.
            await (this.#args.promptForConfirmation ?? promptForConfirmation)({
                label: `Type "${ migrationId }" to force-restart it on "${ connection.environment }"`,
                expected: migrationId,
            });
        }

        if (!dryRun) {
            // Guards against a stale --environment value carried over from a
            // previous command, before issuing a request that mutates ledger state.
            process.stdout.write(`Running on ${ connection.environment } (${ connection.origin })\n`);
        }

        const result = await runBatch(connection.client, migrationId, { dryRun, force, cursor });

        process.stdout.write(renderResult(migrationId, connection.environment, result));
        return 0;
    }
}

function requireValue(value, message) {
    if (!value) {
        throw new UsageError(message);
    }
    return value;
}

async function runBatch(client, migrationId, options) {
    try {
        return await client.runMigration(migrationId, options);
    } catch (error) {
        if (error instanceof MigrationAlreadyAppliedError) {
            throw new UsageError(
                `Migration "${ migrationId }" is already applied. Pass --force to rerun it deliberately.`,
            );
        }
        if (error instanceof MigrationCursorConflictError) {
            throw new UsageError(
                `Migration "${ migrationId }" has an invalid stored cursor and is now failed. `
                + 'Restart it with --force.',
            );
        }
        if (error instanceof MigrationConcurrencyError) {
            throw new UsageError(
                `Another operator advanced migration "${ migrationId }" first. `
                + 'Run list-migrations and retry without --force.',
            );
        }
        throw error;
    }
}

function renderResult(migrationId, environment, result) {
    const { done, status, stats, cursor, dryRun } = result;
    const lines = [
        `done: ${ done }`,
        `status: ${ status }`,
        `stats: ${ JSON.stringify(stats) }`,
        `cursor: ${ cursor }`,
    ];

    if (!done) {
        const next = dryRun
            ? `kixx.js admin run-migration -e ${ environment } ${ migrationId } --dry-run --cursor ${ cursor }`
            : `kixx.js admin run-migration -e ${ environment } ${ migrationId }`;
        lines.push('', `Next: ${ next }`);
    }

    lines.push('');
    return lines.join('\n');
}
