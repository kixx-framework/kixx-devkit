import process from 'node:process';
import { describe, MockTracker } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';
import CloudflareReleaseCommand from '../../../../commands/cloudflare/release.js';

const PROJECT_DIRECTORY = '/app';
const ENVIRONMENT = 'production';
const BUILD_ID = '2026-08-31T18-00-00Z';
const VERSION_ID = 'version-new';
const APP_STATE_FILEPATH = '/app/.kixx/app-state.production.json';
const WORKER_STATE_FILEPATH = '/app/.kixx/cloudflare-state.production.json';

describe('CloudflareReleaseCommand', ({ it }) => {
    it('declares release options and required Cloudflare secrets', () => {
        assertEqual('e', CloudflareReleaseCommand.options.environment.short);
        assert(CloudflareReleaseCommand.options.force, 'expected force option');
        assert(CloudflareReleaseCommand.options.verbose, 'expected verbose option');
        assert(CloudflareReleaseCommand.options.origin, 'expected origin option');
        assert(CloudflareReleaseCommand.options.token, 'expected token option');
        assertEqual('cloudflare.accountId', CloudflareReleaseCommand.requiredSecrets[0]);
        assertEqual('cloudflare.apiToken', CloudflareReleaseCommand.requiredSecrets[1]);
    });

    it('creates, publishes, and deploys a code change in order', async () => {
        await withMockTracker(async (tracker) => {
            const events = [];
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify(makeLiveAppState()),
                [WORKER_STATE_FILEPATH]: JSON.stringify(makePreviousWorkerState()),
            });
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({ events, fileSystem });

            const exitCode = await command.run({ environment: ENVIRONMENT, verbose: true });

            assertEqual(0, exitCode);
            assertEqual('create,publish,deploy', events.map((event) => event.phase).join(','));
            assertEqual(false, events[0].args.deploy);
            assertEqual(BUILD_ID, events[1].args.buildId);
            assertEqual(false, events[1].args.bootstrap);
            assertEqual(VERSION_ID, events[2].args.versionId);

            const output = joinedOutput(stdout);
            assert(output.indexOf('Version phase') < output.indexOf('Publish phase'));
            assert(output.indexOf('Publish phase') < output.indexOf('Deployment phase'));
            assertMatches('Created undeployed; deployment waits for content publish', output);
            assertMatches('Deployed to 100% of traffic.', output);
        });
    });

    it('publishes content onto the live build without creating or deploying a version', async () => {
        await withMockTracker(async (tracker) => {
            const events = [];
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify(makeLiveAppState()),
                [WORKER_STATE_FILEPATH]: JSON.stringify(makePreviousWorkerState()),
            });
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                events,
                fileSystem,
                versionResult: makeSkippedResult(),
            });

            await command.run({ environment: ENVIRONMENT });

            assertEqual('create,publish', events.map((event) => event.phase).join(','));
            assertEqual(undefined, events[1].args.buildId);
            assertEqual(false, events[1].args.bootstrap);

            const output = joinedOutput(stdout);
            assertMatches('No version created.', output);
            assertMatches('No deployment happened because no Worker version was created.', output);
        });
    });

    it('stops after resolving resources', async () => {
        await withMockTracker(async (tracker) => {
            const events = [];
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                events,
                fileSystem: makeFileSystem({}),
                versionResult: makeResourcesResolvedResult(),
            });

            await command.run({ environment: ENVIRONMENT });

            assertEqual('create', events.map((event) => event.phase).join(','));
            assertMatches('No version was created.', joinedOutput(stdout));
        });
    });

    it('leaves a created version undeployed when publishing fails and names recovery', async () => {
        await withMockTracker(async (tracker) => {
            const events = [];
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify(makeLiveAppState()),
                [WORKER_STATE_FILEPATH]: JSON.stringify(makePreviousWorkerState()),
            });
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                events,
                fileSystem,
                publishError: new Error('upload failed'),
            });

            const caught = await catchAsyncError(() => command.run({ environment: ENVIRONMENT }));

            assertEqual('create,publish', events.map((event) => event.phase).join(','));
            assertMatches(`version ${ VERSION_ID } was created but remains undeployed`, caught.message);
            assertMatches('traffic did not move', caught.message);
            assertMatches('release --environment production', caught.message);
            assertMatches('Version phase', joinedOutput(stdout));
        });
    });

    it('resumes an unpublished undeployed version from an interrupted release', async () => {
        await withMockTracker(async (tracker) => {
            const events = [];
            const fileSystem = makeFileSystem({
                [APP_STATE_FILEPATH]: JSON.stringify(makeLiveAppState()),
                [WORKER_STATE_FILEPATH]: JSON.stringify(makeNewWorkerState({ deployed: false })),
            });
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                events,
                fileSystem,
                versionResult: makeSkippedResult(),
            });

            await command.run({ environment: ENVIRONMENT });

            assertEqual('create,publish,deploy', events.map((event) => event.phase).join(','));
            assertEqual(BUILD_ID, events[1].args.buildId);
            assertEqual(VERSION_ID, events[2].args.versionId);
            assertMatches(`Resuming undeployed version ${ VERSION_ID }`, joinedOutput(stdout));
        });
    });

    it('bootstrap-publishes a first release after forced namespace deployment', async () => {
        await withMockTracker(async (tracker) => {
            const events = [];
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                events,
                fileSystem: makeFileSystem({}),
                versionResult: makeCreatedResult({
                    deployed: true,
                    forcedDeploymentClasses: [ 'ContentAddressableIndexStore' ],
                }),
            });

            await command.run({ environment: ENVIRONMENT });

            assertEqual('create,publish', events.map((event) => event.phase).join(','));
            assertEqual(BUILD_ID, events[1].args.buildId);
            assertEqual(true, events[1].args.bootstrap);

            const output = joinedOutput(stdout);
            assertMatches('FIRST RELEASE WINDOW', output);
            assertMatches('Requests can fail until the bootstrap publish', output);
            assertMatches('first-release window is closed', output);
        });
    });

    it('requires an environment before starting a phase', async () => {
        const events = [];
        const command = makeCommand({ events, fileSystem: makeFileSystem({}) });

        const caught = await catchAsyncError(() => command.run({}));

        assertEqual('UsageError', caught.name);
        assertMatches('--environment', caught.message);
        assertEqual(0, events.length);
    });
});

function makeCommand(args) {
    const {
        events,
        fileSystem,
        versionResult = makeCreatedResult(),
        publishError = null,
    } = args;

    return new CloudflareReleaseCommand({
        projectDirectory: PROJECT_DIRECTORY,
        cloudflareConfig: {
            environments: {
                production: { WORKER: { name: 'kixx-app' } },
            },
        },
        config: {
            app: {
                environments: {
                    production: { origin: 'https://example.test' },
                },
            },
        },
        secrets: {
            cloudflare: { accountId: 'account', apiToken: 'cloudflare-token' },
            app: {
                environments: {
                    production: { publishingToken: 'publishing-token' },
                },
            },
        },
        fileSystem,
        createApiClient: () => ({ name: 'api-client' }),
        async createWorkerVersion(createArgs) {
            events.push({ phase: 'create', args: createArgs });
            if (versionResult.outcome === 'created') {
                await fileSystem.writeFile(WORKER_STATE_FILEPATH, JSON.stringify(makeNewWorkerState({
                    deployed: versionResult.deployed,
                })));
            }
            return versionResult;
        },
        async publishApplicationContent(publishArgs) {
            events.push({ phase: 'publish', args: publishArgs });
            if (publishError) {
                throw publishError;
            }
            return makePublishResult(publishArgs.buildId ?? 'live-build');
        },
        async deployWorkerVersion(deployArgs) {
            events.push({ phase: 'deploy', args: deployArgs });
            return makeDeploymentResult();
        },
    });
}

function makeCreatedResult(overrides) {
    return {
        outcome: 'created',
        environment: ENVIRONMENT,
        workerName: 'kixx-app',
        stateFilepath: WORKER_STATE_FILEPATH,
        resolvedResources: [],
        changes: { modules: true, bindings: false, config: false },
        moduleCount: 4,
        buildId: BUILD_ID,
        versionId: VERSION_ID,
        deployed: false,
        retargetedFrom: null,
        forcedDeploymentClasses: null,
        reconciliation: null,
        ...overrides,
    };
}

function makeSkippedResult() {
    return {
        ...makeCreatedResult(),
        outcome: 'skipped',
        buildId: null,
        versionId: null,
    };
}

function makeResourcesResolvedResult() {
    return {
        ...makeSkippedResult(),
        outcome: 'resources-resolved',
        resolvedResources: [
            {
                configKeyPath: 'DOCUMENT_STORE.databaseId',
                id: 'database-id',
                created: false,
            },
        ],
    };
}

function makePreviousWorkerState() {
    return {
        workerName: 'kixx-app',
        buildId: 'live-build',
        versionId: 'version-old',
        createdAt: '2026-08-30T18:00:00.000Z',
        deployed: true,
        modulesHash: 'old-modules-hash',
        bindingsHash: 'bindings-hash',
        configHash: 'config-hash',
    };
}

function makeNewWorkerState(args) {
    return {
        workerName: 'kixx-app',
        buildId: BUILD_ID,
        versionId: VERSION_ID,
        createdAt: '2026-08-31T18:00:00.000Z',
        deployed: args.deployed,
        modulesHash: 'new-modules-hash',
        bindingsHash: 'bindings-hash',
        configHash: 'config-hash',
    };
}

function makeLiveAppState() {
    return {
        liveBuildId: 'live-build',
        deployedAt: '2026-08-30T18:00:00.000Z',
        builds: {
            'live-build': {
                closureHash: 'live-closure',
                publishedAt: '2026-08-30T17:00:00.000Z',
            },
        },
    };
}

function makePublishResult(buildId) {
    return {
        environment: ENVIRONMENT,
        origin: 'https://example.test',
        buildId,
        dryRun: false,
        committed: true,
        matchedCount: 1,
        uploadedCount: 1,
        uploadedResources: [ { type: 'PageMetadata', pathname: '' } ],
        unmatchedFiles: [],
        resources: [],
        closureHash: 'closure-hash',
        nodeCount: 2,
        stateFilepath: APP_STATE_FILEPATH,
    };
}

function makeDeploymentResult() {
    return {
        environment: ENVIRONMENT,
        workerName: 'kixx-app',
        versionId: VERSION_ID,
        buildId: BUILD_ID,
        deployedAt: '2026-08-31T18:05:00.000Z',
        forced: false,
        stateFilepath: APP_STATE_FILEPATH,
        deployment: { id: 'deployment-id' },
    };
}

function makeFileSystem(initialFiles) {
    const files = { ...initialFiles };
    const written = {};

    return {
        async isFile(filepath) {
            return Object.hasOwn(written, filepath) || Object.hasOwn(files, filepath);
        },
        async readFile(filepath) {
            return Object.hasOwn(written, filepath) ? written[filepath] : files[filepath];
        },
        async writeFile(filepath, contents) {
            written[filepath] = contents;
        },
    };
}

async function withMockTracker(fn) {
    const tracker = new MockTracker();
    try {
        await fn(tracker);
    } finally {
        tracker.reset();
    }
}

function joinedOutput(stdout) {
    const chunks = [];

    for (let index = 0; index < stdout.mock.callCount(); index += 1) {
        chunks.push(stdout.mock.getCall(index).arguments[0]);
    }

    return chunks.join('');
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
