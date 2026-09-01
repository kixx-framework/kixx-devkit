import process from 'node:process';
import { assert, assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import CloudflareDeployVersionCommand, {
    renderDeploymentResult,
} from '../../../../commands/cloudflare/deploy-version.js';

describe('CloudflareDeployVersionCommand', ({ it }) => {
    it('declares the environment, force, and optional version id', () => {
        assertEqual('e', CloudflareDeployVersionCommand.options.environment.short);
        assert(CloudflareDeployVersionCommand.options.force);
        assertEqual('version-id', CloudflareDeployVersionCommand.positionals[0].name);
    });

    it('wires both API clients into the guarded deployment', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const cloudflareClient = {};
        const publishingClient = {};
        let received;
        const command = makeCommand({
            cloudflareClient,
            publishingClient,
            deploy: async (options) => {
                received = options;
                return makeResult();
            },
        });

        const exitCode = await command.run({ environment: 'production' }, 'version-id');

        assertEqual(0, exitCode);
        assertEqual(cloudflareClient, received.apiClient);
        assertEqual(publishingClient, received.publishingClient);
        assertEqual('version-id', received.versionId);
        assertMatches('Deployed to 100% of traffic.', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('force bypasses Publishing API client construction and reports it', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let createdPublishingClient = false;
        const command = makeCommand({
            createPublishingClient: () => {
                createdPublishingClient = true;
            },
            deploy: async (options) => makeResult({ guardBypassed: options.force }),
        });

        await command.run({ environment: 'production', force: true }, 'version-id');

        assertEqual(false, createdPublishingClient);
        assertMatches('guard bypassed with --force', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('requires Publishing API settings unless forced', async () => {
        const command = makeCommand({ config: {}, secrets: { cloudflare: {} } });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production' }, 'version-id');
        });

        assertEqual('UsageError', caught.name);
        assertMatches('Publishing API configuration', caught.message);
    });

    it('renders no checkout-local application state output', () => {
        const output = renderDeploymentResult(makeResult());

        assertMatches('BUILD_ID:    build-id', output);
        assertEqual(false, output.includes('Wrote'));
    });
});

function makeCommand(args) {
    const {
        cloudflareClient = {},
        publishingClient = {},
        createPublishingClient = () => publishingClient,
        deploy = async () => makeResult(),
        config = {
            app: { environments: { production: { origin: 'https://app.example.com' } } },
        },
        secrets = {
            cloudflare: {},
            app: { environments: { production: { publishingToken: 'token' } } },
        },
    } = args ?? {};

    return new CloudflareDeployVersionCommand({
        projectDirectory: '/app',
        cloudflareConfig: {
            environments: { production: { WORKER: { name: 'worker' } } },
        },
        config,
        secrets,
        createCloudflareClient: () => cloudflareClient,
        createPublishingClient,
        deployCloudflareVersion: deploy,
    });
}

function makeResult(overrides) {
    return {
        environment: 'production',
        workerName: 'worker',
        versionId: 'version-id',
        buildId: 'build-id',
        guardBypassed: false,
        ...overrides,
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }

    throw new Error('Expected an error');
}
