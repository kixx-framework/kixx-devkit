import process from 'node:process';
import { describe, MockTracker } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';
import AppPublishCommand, {
    renderPublishResult,
} from '../../../../commands/app/publish.js';
import publishApplicationContent from '../../../../lib/publishing/publish-application-content.js';

const STATE_FILEPATH = '/app/.kixx/app-state.production.json';
const CONTENT_SOURCES = {
    resources: [],
    unmatchedFiles: [],
    problems: [],
};

describe('AppPublishCommand', ({ describe, it }) => {
    it('declares every publishing option', () => {
        assertEqual('e', AppPublishCommand.options.environment.short);

        for (const option of [
            'environment',
            'build-id',
            'bootstrap',
            'dry-run',
            'verbose',
            'origin',
            'token',
        ]) {
            assert(AppPublishCommand.options[option], `expected ${ option } option`);
        }
    });

    it('requires an environment', async () => {
        const command = makeCommand();

        const caught = await catchAsyncError(() => command.run({}));

        assertUsageError(caught, '--environment');
    });

    it('requires the environment origin from the named config path', async () => {
        const command = makeCommand({ config: {} });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assertUsageError(caught, '.kixx/config.json');
        assertMatches('app.environments.production.origin', caught.message);
    });

    it('requires the environment token from the named secrets path', async () => {
        const command = makeCommand({ secrets: {} });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assertUsageError(caught, '.kixx/secrets.json');
        assertMatches('app.environments.production.publishingToken', caught.message);
    });

    it('requires an explicit build id when no live build is recorded', async () => {
        const command = makeCommand();

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assertUsageError(caught, '.kixx/app-state.production.json');
        assertMatches('--build-id', caught.message);
        assertMatches('--bootstrap', caught.message);
    });

    it('publishes onto the recorded live build and records a successful closure', async () => {
        await withMockTracker(async (tracker) => {
            const fileSystem = makeFileSystem({
                [STATE_FILEPATH]: JSON.stringify({
                    liveBuildId: 'live-build',
                    deployedAt: '2026-08-31T12:00:00.000Z',
                    builds: {},
                }),
            });
            let publishArgs;
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                fileSystem,
                async publishContent(args) {
                    publishArgs = args;
                    return makeResult({
                        buildId: args.buildId,
                        committed: true,
                        closureHash: 'closure-hash',
                        nodeCount: 4,
                    });
                },
            });

            const exitCode = await command.run({ environment: 'production' });

            assertEqual(0, exitCode);
            assertEqual('live-build', publishArgs.buildId);
            assertEqual(false, publishArgs.bootstrap);
            assertEqual(false, publishArgs.dryRun);
            const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);
            assertEqual('live-build', state.liveBuildId);
            assertEqual('closure-hash', state.builds['live-build'].closureHash);
            assertEqual('2026-08-31T15:30:00.000Z', state.builds['live-build'].publishedAt);
            assertMatches('Wrote .kixx/app-state.production.json', stdout.mock.getCall(0).arguments[0]);
        });
    });

    it('uses explicit build, origin, and token overrides without printing the token', async () => {
        await withMockTracker(async (tracker) => {
            let clientOptions;
            let publishArgs;
            const stdout = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                config: {},
                secrets: {},
                createClient(options) {
                    clientOptions = options;
                    return { name: 'client' };
                },
                async publishContent(args) {
                    publishArgs = args;
                    return makeResult({ buildId: args.buildId, dryRun: true });
                },
            });

            await command.run({
                environment: 'production',
                'build-id': 'explicit-build',
                origin: 'https://override.example',
                token: 'never-print-this-token',
                'dry-run': true,
            });

            assertEqual('explicit-build', publishArgs.buildId);
            assertEqual('https://override.example', clientOptions.origin);
            assertEqual('never-print-this-token', clientOptions.token);
            const output = stdout.mock.getCall(0).arguments[0];
            assertMatches('https://override.example', output);
            assert(!output.includes('never-print-this-token'), 'expected token to be absent from output');
        });
    });

    it('passes bootstrap and dry-run through without writing local state', async () => {
        await withMockTracker(async (tracker) => {
            const fileSystem = makeFileSystem({});
            let publishArgs;
            tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                fileSystem,
                async publishContent(args) {
                    publishArgs = args;
                    return makeResult({ buildId: args.buildId, dryRun: true, bootstrap: true });
                },
            });

            await command.run({
                environment: 'production',
                'build-id': 'new-build',
                bootstrap: true,
                'dry-run': true,
            });

            assertEqual(true, publishArgs.bootstrap);
            assertEqual(true, publishArgs.dryRun);
            assertEqual(0, Object.keys(fileSystem.written).length);
        });
    });

    it('does not write state when publishing fails', async () => {
        const fileSystem = makeFileSystem({});
        const command = makeCommand({
            fileSystem,
            async publishContent() {
                throw new Error('publish failed');
            },
        });

        const caught = await catchAsyncError(() => command.run({
            environment: 'production',
            'build-id': 'build-id',
        }));

        assertEqual('publish failed', caught.message);
        assertEqual(0, Object.keys(fileSystem.written).length);
    });

    describe('renderPublishResult()', ({ it }) => {
        it('renders summary, uploaded resources, unmatched files, and closure', () => {
            const text = renderPublishResult({
                result: makeResult({
                    committed: true,
                    closureHash: 'closure-hash',
                    nodeCount: 7,
                    matchedCount: 2,
                    uploadedCount: 1,
                    uploadedResources: [ makeResource({ disposition: undefined }) ],
                    unmatchedFiles: [ 'templates/README.md' ],
                }),
                environment: 'production',
                origin: 'https://example.com',
                verbose: false,
                stateFilepath: '.kixx/app-state.production.json',
            });

            assertMatches('Resources: 3 total; 2 matched; 1 uploaded', text);
            assertMatches('PageMetadata /about', text);
            assertMatches('templates/README.md', text);
            assertMatches('Closure: closure-hash (7 nodes)', text);
        });

        it('renders every hash and disposition in verbose output', () => {
            const text = renderPublishResult({
                result: makeResult({
                    dryRun: true,
                    matchedCount: 1,
                    uploadedCount: 1,
                    resources: [
                        makeResource({ disposition: 'matched' }),
                        makeResource({ pathname: '/contact', hash: 'hash-2', disposition: 'uploaded' }),
                    ],
                    uploadedResources: [ makeResource({ pathname: '/contact', disposition: undefined }) ],
                }),
                environment: 'staging',
                origin: 'https://example.com',
                verbose: true,
                stateFilepath: null,
            });

            assertMatches('1 would upload', text);
            assertMatches('matched  PageMetadata /about hash-1 12 bytes', text);
            assertMatches('uploaded PageMetadata /contact hash-2 12 bytes', text);
            assertMatches('no resources, closure, or local state were written', text);
        });
    });
});

function makeCommand(overrides) {
    const {
        fileSystem = makeFileSystem({}),
        scanContentSources: scan = async () => CONTENT_SOURCES,
        publishContent: publish = async (args) => makeResult({ buildId: args.buildId }),
        createClient = (options) => ({ options }),
        now = () => new Date('2026-08-31T15:30:00.000Z'),
        ...commandOverrides
    } = overrides ?? {};
    const args = {
        projectDirectory: '/app',
        config: {
            app: {
                environments: {
                    production: { origin: 'https://example.com' },
                },
            },
        },
        secrets: {
            app: {
                environments: {
                    production: { publishingToken: 'publishing-token' },
                },
            },
        },
        async publishApplicationContent(operationArgs) {
            return await publishApplicationContent({
                ...operationArgs,
                fileSystem,
                scan,
                publish,
                createClient,
                now,
            });
        },
        ...commandOverrides,
    };

    return new AppPublishCommand(args);
}

function makeResult(overrides) {
    return {
        buildId: 'build-id',
        dryRun: false,
        bootstrap: false,
        bootstrapped: false,
        committed: false,
        matchedCount: 0,
        uploadedCount: 0,
        completedUploadCount: 0,
        uploadedResources: [],
        resources: [],
        unmatchedFiles: [],
        closureHash: null,
        nodeCount: null,
        ...overrides,
    };
}

function makeResource(overrides) {
    return {
        type: 'PageMetadata',
        pathname: '/about',
        hash: 'hash-1',
        size: 12,
        disposition: 'matched',
        ...overrides,
    };
}

function makeFileSystem(files) {
    const written = {};

    return {
        written,
        async isFile(filepath) {
            return Object.hasOwn(files, filepath);
        },
        async readFile(filepath) {
            return files[filepath];
        },
        async writeFile(filepath, contents) {
            written[filepath] = contents;
            files[filepath] = contents;
        },
    };
}

function assertUsageError(error, message) {
    assert(error, 'expected an error to be thrown');
    assertEqual('UsageError', error.name);
    assertMatches(message, error.message);
}

async function withMockTracker(callback) {
    const tracker = new MockTracker();

    try {
        return await callback(tracker);
    } finally {
        tracker.reset();
    }
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
