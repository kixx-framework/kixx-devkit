import process from 'node:process';

import resolveAdminEnvironment from '../../lib/admin/resolve-admin-environment.js';
import { promptForValue } from '../../lib/prompt.js';
import { subcommands } from './index.js';

export default class AdminListMigrationsCommand {

    static description = subcommands['list-migrations'].description;

    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        origin: { type: 'string', description: 'Override the configured Admin API origin' },
    };

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options) {
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

        const migrations = await connection.client.listMigrations();

        process.stdout.write(renderMigrations(migrations));
        return 0;
    }
}

function renderMigrations(migrations) {
    const lines = migrations.map((migration) => {
        const line = `${ migration.id }  ${ migration.status }  ${ migration.description }`;
        if (migration.status === 'failed' && migration.error) {
            return `${ line }\n  error: ${ migration.error }`;
        }
        return line;
    });

    return `${ lines.join('\n') }\n`;
}
