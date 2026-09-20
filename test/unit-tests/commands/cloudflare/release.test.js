import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';
import CloudflareReleaseCommand from '../../../../commands/cloudflare/release.js';
import captureOutput from '../../helpers/capture-output.js';

describe('CloudflareReleaseCommand', ({ it }) => {
    it('passes resolved clients and options to the release coordinator', async () => {
        const output = captureOutput();
        let received;
        const command = makeCommand(async (options) => {
            received = options;
            return { outcome: 'resources-resolved', prepared: resourcesResolved() };
        }, output);

        const exitCode = await command.run({ environment: 'production', force: true });

        assertEqual(0, exitCode);
        assertEqual(true, received.force);
        assertEqual('https://app.example.com', received.origin);
        assertMatches('Traffic was unchanged', output.chunks[2]);
    });

    it('warns in Worker preparation about undeclared secrets on the source version', async () => {
        const output = captureOutput();
        const prepared = { ...resourcesResolved(), undeclaredSecretNames: [ 'OLD_SECRET' ] };
        const command = makeCommand(async () => ({ outcome: 'resources-resolved', prepared }), output);

        await command.run({ environment: 'production' });

        const text = output.chunks[1];
        assertMatches('OLD_SECRET', text);
        assertMatches('do not inherit', text);
    });

    it('requires an environment before constructing clients', async () => {
        const command = makeCommand(async () => resourcesResolved());
        let caught;
        try {
            await command.run({});
        } catch (error) {
            caught = error;
        }

        assertEqual('UsageError', caught.name);
    });
});

function makeCommand(release, output = captureOutput()) {
    return new CloudflareReleaseCommand({
        output,
        projectDirectory: '/app',
        cloudflareConfig: {},
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: {
            cloudflare: {},
            app: { environments: { production: { publishingToken: 'secret' } } },
        },
        fileSystem: {
            async isFile() {
                return false;
            },
        },
        createApiClient: () => ({ kind: 'cloudflare' }),
        createPublishingClient: () => ({ kind: 'publishing' }),
        release,
    });
}

function resourcesResolved() {
    return {
        outcome: 'resources-resolved',
        environment: 'production',
        workerName: 'worker',
        resolvedResources: [],
        undeclaredSecretNames: [],
    };
}
