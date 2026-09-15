import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import CloudflareSetSecretCommand from '../../../../commands/cloudflare/set-secret.js';

const STATE_FILEPATH = '/app/.kixx/cloudflare-state.production.json';

describe('CloudflareSetSecretCommand', ({ it }) => {
    it('reads one secret outside argv, calls the workflow once, and reports no value', async () => {
        const calls = [];
        const output = makeOutput();
        const apiClient = {};
        const command = new CloudflareSetSecretCommand({
            projectDirectory: '/app',
            cloudflareConfig: { environments: {} },
            secrets: { cloudflare: { accountId: 'account', apiToken: 'token' } },
            input: { isTTY: true },
            output,
            createApiClient(options) {
                assertEqual('account', options.accountId);
                return apiClient;
            },
            async readSecretValue(options) {
                assertEqual(true, options.input.isTTY);
                return 'FAKE_SECRET_VALUE';
            },
            async setWorkerSecrets(options) {
                calls.push(options);
                return makeResult();
            },
        });

        const exitCode = await command.run({ environment: 'production' }, 'API_KEY');

        assertEqual(0, exitCode);
        assertEqual(1, calls.length);
        assertEqual('FAKE_SECRET_VALUE', calls[0].secrets.API_KEY);
        assertEqual('kixx.js cloudflare set-secret', calls[0].command);
        assertEqual(apiClient, calls[0].apiClient);
        assert(output.text.includes('API_KEY'), 'expected changed name');
        assert(output.text.includes('new-version-id (undeployed)'), 'expected undeployed version');
        assert(output.text.includes('existing-build-id'), 'expected preserved BUILD_ID');
        assert(output.text.includes(STATE_FILEPATH), 'expected state filepath');
        assert(!output.text.includes('FAKE_SECRET_VALUE'), 'expected no secret value in output');
    });

    it('rejects missing or extra positionals and environment before reading input', async () => {
        let readCount = 0;
        const command = new CloudflareSetSecretCommand({
            secrets: { cloudflare: {} },
            async readSecretValue() {
                readCount += 1;
                return 'fake';
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
        assertEqual(0, readCount);
    });
});

function makeResult() {
    return {
        environment: 'production',
        workerName: 'example-worker',
        changedSecretNames: [ 'API_KEY' ],
        versionId: 'new-version-id',
        buildId: 'existing-build-id',
        stateFilepath: STATE_FILEPATH,
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
