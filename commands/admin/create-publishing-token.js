import process from 'node:process';
import { isUndefined } from 'kixx-assert';

import resolveAdminEnvironment from '../../lib/admin/resolve-admin-environment.js';
import { promptForValue } from '../../lib/prompt.js';
import { subcommands } from './index.js';

export default class AdminCreatePublishingTokenCommand {

    static description = subcommands['create-publishing-token'].description;

    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        origin: { type: 'string', description: 'Override the configured Admin API origin' },
        roles: { type: 'string', multiple: true, description: 'Publishing role ids, defaults to editor' },
        ttl: { type: 'string', description: 'Time to live in seconds, defaults to 2592000' },
        description: { type: 'string', description: 'Operator-facing description for the minted token' },
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

        const ttl = isUndefined(options?.ttl) ? undefined : Number.parseInt(options.ttl, 10);

        const token = await connection.client.createPublishingApiToken({
            roles: options?.roles,
            ttl,
            description: options?.description,
        });

        process.stdout.write(renderToken(token, connection.environment));
        return 0;
    }
}

function renderToken(token, environment) {
    const lines = [
        'Publishing API token created. This value is shown once and cannot be retrieved again:',
        '',
        `  ${ token.token }`,
        '',
        `Store it as app.environments.${ environment }.publishingToken in .kixx/secrets.json.`,
        `Roles: ${ token.roles.join(', ') }`,
        `Description: ${ token.description ?? '(none)' }`,
        `Expires: ${ token.tokenExpirationDate }`,
        '',
    ];
    return lines.join('\n');
}
