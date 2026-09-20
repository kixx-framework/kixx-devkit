import process from 'node:process';
import { assert, assertEqual, assertMatches, assertUndefined } from 'kixx-assert';
import { describe } from 'kixx-test';

import AdminCreatePublishingTokenCommand from '../../../../commands/admin/create-publishing-token.js';
import captureOutput from '../../helpers/capture-output.js';

describe('AdminCreatePublishingTokenCommand', ({ it }) => {
    it('prints the one-time token, roles, description, and expiration', async () => {
        const output = captureOutput();
        const command = makeCommand({
            output,
            client: {
                createPublishingApiToken: async () => ({
                    token: 'kxpat_secret',
                    roles: [ 'editor' ],
                    description: 'CMS production deploy',
                    tokenExpirationDate: '2026-09-26T12:00:00.000Z',
                }),
            },
        });

        const code = await command.run({ environment: 'production' });
        const text = output.chunks[0];

        assertEqual(0, code);
        assertMatches('kxpat_secret', text);
        assertMatches('shown once', text);
        assertMatches('app.environments.production.publishingToken', text);
        assertMatches('editor', text);
        assertMatches('CMS production deploy', text);
    });

    it('omits roles, ttl, and description from the request when not supplied', async () => {
        const received = {};
        const command = makeCommand({
            client: {
                createPublishingApiToken: async (attributes) => {
                    Object.assign(received, attributes);
                    return { token: 't', roles: [ 'editor' ], tokenExpirationDate: 'later' };
                },
            },
        });

        await command.run({ environment: 'production' });

        assertUndefined(received.roles);
        assertUndefined(received.ttl);
        assertUndefined(received.description);
    });

    it('throws a UsageError naming the environment variable when stdin is not a TTY', async () => {
        delete process.env.KIXX_ADMIN_EMAIL;
        const command = new AdminCreatePublishingTokenCommand({ config: {} });

        // promptForValue falls back to the real process.stdin here, so force
        // isTTY off rather than relying on how this suite happens to run.
        const wasTTY = process.stdin.isTTY;
        process.stdin.isTTY = false;

        let caught;
        try {
            caught = await catchAsyncError(() => command.run({ environment: 'production' }));
        } finally {
            process.stdin.isTTY = wasTTY;
        }

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertMatches('KIXX_ADMIN_EMAIL', caught.message);
    });
});

function makeCommand(args) {
    const { client, output = captureOutput() } = args;

    return new AdminCreatePublishingTokenCommand({
        output,
        config: { app: { environments: { production: { origin: 'https://admin.example.test' } } } },
        createClient: () => client,
        promptForValue: async () => 'stub-value',
    });
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
