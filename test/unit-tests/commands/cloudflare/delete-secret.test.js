import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import CloudflareDeleteSecretCommand from '../../../../commands/cloudflare/delete-secret.js';

describe('CloudflareDeleteSecretCommand', ({ it }) => {
    it('calls the delete workflow once and reports the undeployed version', async () => {
        const calls = [];
        const output = makeOutput();
        const command = new CloudflareDeleteSecretCommand({
            projectDirectory: '/app',
            cloudflareConfig: { environments: {} },
            secrets: { cloudflare: { accountId: 'account', apiToken: 'token' } },
            output,
            createApiClient: () => ({}),
            async deleteWorkerSecret(options) {
                calls.push(options);
                return makeResult();
            },
        });

        const exitCode = await command.run({ environment: 'production' }, 'OLD_SECRET');

        assertEqual(0, exitCode);
        assertEqual(1, calls.length);
        assertEqual('OLD_SECRET', calls[0].name);
        assertEqual('kixx.js cloudflare delete-secret', calls[0].command);
        assert(output.text.includes('OLD_SECRET'), 'expected changed name');
        assert(output.text.includes('new-version-id (undeployed)'), 'expected undeployed version');
        assert(!Object.prototype.hasOwnProperty.call(calls[0], 'publishingClient'));
    });

    it('rejects missing or extra positionals and environment before creating a client', async () => {
        let clientCount = 0;
        const command = new CloudflareDeleteSecretCommand({
            secrets: { cloudflare: {} },
            createApiClient() {
                clientCount += 1;
                return {};
            },
        });
        const calls = [
            () => command.run({ environment: 'production' }),
            () => command.run({ environment: 'production' }, 'ONE', 'TWO'),
            () => command.run({}, 'ONE'),
        ];

        for (const call of calls) {
            const caught = await catchAsyncError(call);
            assertEqual('UsageError', caught.name);
        }
        assertEqual(0, clientCount);
    });
});

function makeResult() {
    return {
        environment: 'production',
        workerName: 'example-worker',
        changedSecretNames: [ 'OLD_SECRET' ],
        versionId: 'new-version-id',
        buildId: 'existing-build-id',
        stateFilepath: '/app/.kixx/cloudflare-state.production.json',
    };
}

function makeOutput() {
    return {
        text: '',
        write(text) {
            this.text += text;
        },
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
