import process from 'node:process';
import { assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';
import CloudflareReleaseCommand from '../../../../commands/cloudflare/release.js';

describe('CloudflareReleaseCommand', ({ it }) => {
    it('passes resolved clients and options to the release coordinator', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let received;
        const command = makeCommand(async (options) => {
            received = options;
            return { outcome: 'resources-resolved', prepared: resourcesResolved() };
        });

        const exitCode = await command.run({ environment: 'production', force: true });

        assertEqual(0, exitCode);
        assertEqual(true, received.force);
        assertEqual('https://app.example.com', received.origin);
        assertMatches('Traffic was unchanged', stdout.mock.getCall(2).arguments[0]);
        tracker.reset();
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

function makeCommand(release) {
    return new CloudflareReleaseCommand({
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
    };
}
