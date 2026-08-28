import process from 'node:process';
import { describe, MockTracker } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';
import CloudflareCreateWorkerCommand from '../../../../commands/cloudflare/create-worker.js';


describe('CloudflareCreateWorkerCommand', ({ it }) => {
    it('requires an environment option', async () => {
        const command = makeCommand();

        const caught = await catchAsyncError(() => command.run({}));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertEqual('The --environment option is required', caught.message);
    });

    it('requires a WORKER block for the selected environment', async () => {
        const command = makeCommand();

        const caught = await catchAsyncError(() => command.run({ environment: 'staging' }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertMatches('environments.staging.WORKER', caught.message);
    });

    it('creates a Worker with the selected environment WORKER block', async () => {
        await withMockTracker(async (tracker) => {
            const workerConfig = {
                name: 'production-worker',
                logpush: false,
                tags: [ 'public-api' ],
                observability: {
                    enabled: true,
                },
            };
            const worker = { id: 'worker-id', name: workerConfig.name };
            const fetchMock = tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({ success: true, result: worker });
            });
            const stdoutMock = tracker.method(process.stdout, 'write', () => true);
            const command = makeCommand({
                name: 'obsolete-top-level-name',
                environments: {
                    production: { WORKER: workerConfig },
                },
            });

            const exitCode = await command.run({ environment: 'production' });

            assertEqual(0, exitCode);
            assertEqual(1, fetchMock.mock.callCount());
            assertEqual(
                JSON.stringify(workerConfig),
                fetchMock.mock.getCall(0).arguments[1].body,
            );
            assertEqual(`${ JSON.stringify(worker, null, 4) }\n`, stdoutMock.mock.getCall(0).arguments[0]);
        });
    });
});

function makeCommand(cloudflareConfig = { environments: {} }) {
    return new CloudflareCreateWorkerCommand({
        cloudflareConfig,
        secrets: {
            cloudflare: {
                accountId: 'account-id',
                apiToken: 'api-token',
            },
        },
    });
}

function makeApiResponse(envelope) {
    return {
        ok: true,
        status: 200,
        async json() {
            return envelope;
        },
    };
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
