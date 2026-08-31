import process from 'node:process';
import { describe, MockTracker } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';
import CloudflareDeployVersionCommand from '../../../../commands/cloudflare/deploy-version.js';

const APP_STATE_FILEPATH = '/app/.kixx/app-state.production.json';
const WORKER_STATE_FILEPATH = '/app/.kixx/cloudflare-state.production.json';
const BUILD_ID = '2026-08-31T14-02-11Z';
const VERSION_ID = 'version-id';

describe('CloudflareDeployVersionCommand', ({ it }) => {
    it('declares the environment, force, and optional version-id arguments', () => {
        assertEqual('e', CloudflareDeployVersionCommand.options.environment.short);
        assert(CloudflareDeployVersionCommand.options.force, 'expected force option');
        assertEqual('version-id', CloudflareDeployVersionCommand.positionals[0].name);
        assertEqual(false, CloudflareDeployVersionCommand.positionals[0].required);
    });

    it('deploys a named version to all traffic and records its Cloudflare build id', async () => {
        await withMockTracker(async (tracker) => {
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify(makeAppState()),
            });
            const apiClient = makeApiClient();
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({ fileSystem, apiClient });

            const exitCode = await command.run({ environment: 'production' }, VERSION_ID);

            assertEqual(0, exitCode);
            assertEqual('kixx-app', apiClient.calls.getWorkerVersion[0].workerName);
            assertEqual(VERSION_ID, apiClient.calls.getWorkerVersion[0].versionId);
            assertEqual('percentage', apiClient.calls.createDeployment[0].deployment.strategy);
            assertEqual(100, apiClient.calls.createDeployment[0].deployment.versions[0].percentage);
            assertEqual(VERSION_ID, apiClient.calls.createDeployment[0].deployment.versions[0].version_id);
            assertEqual(false, apiClient.calls.createDeployment[0].options.force);

            const state = JSON.parse(fileSystem.written[APP_STATE_FILEPATH]);
            assertEqual(BUILD_ID, state.liveBuildId);
            assertEqual('2026-08-31T16:00:00.000Z', state.deployedAt);
            assertEqual('closure-hash', state.builds[BUILD_ID].closureHash);

            const output = stdout.mock.getCall(0).arguments[0];
            assertMatches('Deployed to 100% of traffic.', output);
            assertMatches(`Version:     ${ VERSION_ID }`, output);
            assertMatches(`BUILD_ID:    ${ BUILD_ID }`, output);
            assertMatches('Wrote .kixx/app-state.production.json', output);
        });
    });

    it('defaults to the recorded Worker version', async () => {
        await withMockTracker(async (tracker) => {
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify(makeAppState()),
                [WORKER_STATE_FILEPATH]: JSON.stringify({ versionId: 'recorded-version' }),
            });
            const apiClient = makeApiClient();
            tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({ fileSystem, apiClient });

            await command.run({ environment: 'production' });

            assertEqual('recorded-version', apiClient.calls.getWorkerVersion[0].versionId);
        });
    });

    it('requires an environment before making a Cloudflare request', async () => {
        const apiClient = makeApiClient();
        const command = makeCommand({ fileSystem: makeFileSystem({}), apiClient });

        const caught = await catchAsyncError(() => command.run({}));

        assertUsageError(caught, '--environment');
        assertEqual(0, apiClient.calls.getWorkerVersion.length);
    });

    it('requires a named or recorded version', async () => {
        const command = makeCommand({
            fileSystem: makeFileSystem({}),
            apiClient: makeApiClient(),
        });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assertUsageError(caught, '.kixx/cloudflare-state.production.json');
    });

    it('refuses an unpublished build with the publish remedy and force override', async () => {
        const originalState = JSON.stringify({ builds: {} });
        const fileSystem = makeFileSystem({ [APP_STATE_FILEPATH]: originalState });
        const apiClient = makeApiClient();
        const command = makeCommand({ fileSystem, apiClient });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production' }, VERSION_ID);
        });

        assertUsageError(caught, 'Every request would fail');
        assertMatches(`app publish --environment production --build-id ${ BUILD_ID }`, caught.message);
        assertMatches('--force', caught.message);
        assertEqual(0, apiClient.calls.createDeployment.length);
        assertEqual(originalState, fileSystem.files[APP_STATE_FILEPATH]);
        assertEqual(0, Object.keys(fileSystem.written).length);
    });

    it('force deploys without a publish record and forwards Cloudflare force', async () => {
        await withMockTracker(async (tracker) => {
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify({ builds: {} }),
            });
            const apiClient = makeApiClient();
            tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({ fileSystem, apiClient });

            await command.run({ environment: 'production', force: true }, VERSION_ID);

            assertEqual(true, apiClient.calls.createDeployment[0].options.force);
            const state = JSON.parse(fileSystem.written[APP_STATE_FILEPATH]);
            assertEqual(BUILD_ID, state.liveBuildId);
        });
    });

    it('leaves app state untouched when deployment fails', async () => {
        const originalState = JSON.stringify(makeAppState());
        const fileSystem = makeFileSystem({ [APP_STATE_FILEPATH]: originalState });
        const apiClient = makeApiClient({ deploymentError: new Error('deployment failed') });
        const command = makeCommand({ fileSystem, apiClient });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production' }, VERSION_ID);
        });

        assertEqual('deployment failed', caught.message);
        assertEqual(originalState, fileSystem.files[APP_STATE_FILEPATH]);
        assertEqual(0, Object.keys(fileSystem.written).length);
    });

    it('reports an unknown Cloudflare version as a UsageError', async () => {
        const error = new Error('Cloudflare request failed: version not found');
        error.status = 404;
        const apiClient = makeApiClient({ versionError: error });
        const command = makeCommand({ fileSystem: makeFileSystem({}), apiClient });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production' }, 'missing-version');
        });

        assertUsageError(caught, 'missing-version');
        assertMatches('version not found', caught.message);
        assertEqual(0, apiClient.calls.createDeployment.length);
    });

    it('refuses a version without a plain-text BUILD_ID binding', async () => {
        const apiClient = makeApiClient({ version: { bindings: [] } });
        const command = makeCommand({ fileSystem: makeFileSystem({}), apiClient });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production' }, VERSION_ID);
        });

        assertUsageError(caught, 'plain-text BUILD_ID');
        assertEqual(0, apiClient.calls.createDeployment.length);
    });
});

function makeCommand(args) {
    const {
        fileSystem,
        apiClient,
        cloudflareConfig = {
            environments: {
                production: {
                    WORKER: { name: 'kixx-app' },
                },
            },
        },
    } = args ?? {};

    return new CloudflareDeployVersionCommand({
        projectDirectory: '/app',
        cloudflareConfig,
        secrets: {
            cloudflare: {
                accountId: 'account-id',
                apiToken: 'api-token',
            },
        },
        fileSystem,
        createApiClient: () => apiClient,
        now: () => new Date('2026-08-31T17:00:00.000Z'),
    });
}

function makeApiClient(args) {
    const {
        version = {
            id: VERSION_ID,
            bindings: [
                { type: 'plain_text', name: 'BUILD_ID', text: BUILD_ID },
            ],
        },
        versionError = null,
        deploymentError = null,
    } = args ?? {};
    const calls = {
        getWorkerVersion: [],
        createDeployment: [],
    };

    return {
        calls,
        async getWorkerVersion(workerName, versionId) {
            calls.getWorkerVersion.push({ workerName, versionId });
            if (versionError) {
                throw versionError;
            }
            return version;
        },
        async createDeployment(workerName, deployment, options) {
            calls.createDeployment.push({ workerName, deployment, options });
            if (deploymentError) {
                throw deploymentError;
            }
            return {
                id: 'deployment-id',
                created_on: '2026-08-31T16:00:00.000Z',
            };
        },
    };
}

function makeAppState() {
    return {
        liveBuildId: 'old-build',
        deployedAt: '2026-08-30T16:00:00.000Z',
        builds: {
            [BUILD_ID]: {
                closureHash: 'closure-hash',
                publishedAt: '2026-08-31T15:00:00.000Z',
            },
        },
    };
}

function makeFileSystem(initialFiles) {
    const files = { ...initialFiles };
    const written = {};

    return {
        files,
        written,
        async isFile(filepath) {
            return Object.hasOwn(files, filepath);
        },
        async readFile(filepath) {
            return files[filepath];
        },
        async writeFile(filepath, contents) {
            files[filepath] = contents;
            written[filepath] = contents;
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

function assertUsageError(error, message) {
    assert(error, 'expected an error');
    assertEqual('UsageError', error.name);
    assertMatches(message, error.message);
}

async function withMockTracker(callback) {
    const tracker = new MockTracker();

    try {
        await callback(tracker);
    } finally {
        tracker.reset();
    }
}
