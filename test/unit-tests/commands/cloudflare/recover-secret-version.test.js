import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import Command from '../../../../commands/cloudflare/recover-secret-version.js';

describe('cloudflare recover-secret-version command', ({ it }) => {
    it('passes the explicit version and environment to recovery and reports unchanged traffic', async () => {
        let received;
        let output = '';
        const client = {};
        const command = new Command({
            projectDirectory: '/app',
            secrets: { cloudflare: {} },
            createApiClient: () => client,
            output: {
                write(value) {
                    output += value;
                },
            },
            async recoverSecretVersion(args) {
                received = args;
                return {
                    workerName: 'worker', versionId: args.versionId, buildId: 'build',
                    stateFilepath: '/app/.kixx/cloudflare-state.production.json',
                    undeclaredSecretNames: [],
                };
            },
        });
        assertEqual(0, await command.run({ environment: 'production' }, 'exact-version'));
        assertEqual('production', received.environment);
        assertEqual('exact-version', received.versionId);
        assertEqual(client, received.apiClient);
        assert(output.includes('Traffic was unchanged'));
    });

    it('rejects missing or extra version arguments before invoking recovery', async () => {
        let calls = 0;
        const command = new Command({
            async recoverSecretVersion() {
                calls += 1;
            },
        });
        for (const args of [ [], [ 'one', 'two' ] ]) {
            let caught;
            try {
                await command.run({ environment: 'production' }, ...args);
            } catch (error) {
                caught = error;
            }
            assertEqual('UsageError', caught.name);
        }
        assertEqual(0, calls);
    });
});
