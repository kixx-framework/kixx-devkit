import process from 'node:process';

import resolveAdminEnvironment from '../../lib/admin/resolve-admin-environment.js';
import { InvalidInviteError } from '../../lib/admin/admin-api-error.js';
import { promptForValue, promptForValueTwice } from '../../lib/prompt.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_LENGTH = 256;

export default class AdminAcceptInviteCommand {

    static description = subcommands['accept-invite'].description;

    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        origin: { type: 'string', description: 'Override the configured Admin API origin' },
    };

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options) {
        const inviteToken = await (this.#args.promptForValue ?? promptForValue)({
            envVar: 'KIXX_ADMIN_INVITE_TOKEN',
            label: 'Invite token',
            mask: true,
        });
        const emailAddress = await (this.#args.promptForValue ?? promptForValue)({
            envVar: 'KIXX_ADMIN_EMAIL',
            label: 'New admin email address',
        });
        const password = await (this.#args.promptForValueTwice ?? promptForValueTwice)({
            envVar: 'KIXX_ADMIN_PASSWORD',
            label: 'New admin password',
        });

        // Checked locally because a 422 here does not consume the invite, but
        // there is no reason to make the operator discover that by failing.
        if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
            throw new UsageError(
                `New admin password must be ${ MIN_PASSWORD_LENGTH } to ${ MAX_PASSWORD_LENGTH } characters`,
            );
        }

        const connection = (this.#args.resolveAdminEnvironment ?? resolveAdminEnvironment)({
            environment: options?.environment,
            config: this.#args.config,
            origin: options?.origin,
            createClient: this.#args.createClient,
        });

        const account = await acceptInvite(connection.client, inviteToken, { emailAddress, password });

        process.stdout.write(
            `Created admin account ${ account.adminUserId } <${ account.emailAddress }> `
            + `at ${ account.userCreationDate }\n`,
        );
        return 0;
    }
}

async function acceptInvite(client, inviteToken, account) {
    try {
        return await client.acceptInvite(inviteToken, account);
    } catch (error) {
        if (error instanceof InvalidInviteError) {
            throw new UsageError(
                'The invite token is unknown, expired, revoked, or already used.',
            );
        }
        throw error;
    }
}
