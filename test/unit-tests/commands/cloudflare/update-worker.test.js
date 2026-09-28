import { describe, MockTracker } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';
import CloudflareUpdateWorkerCommand from '../../../../commands/cloudflare/update-worker.js';
import captureOutput from '../../helpers/capture-output.js';


describe('CloudflareUpdateWorkerCommand', ({ it }) => {
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

    it('replaces the Worker configuration with the selected environment WORKER block', async () => {
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
            const output = captureOutput();
            const command = makeCommand({
                environments: {
                    production: { WORKER: workerConfig },
                },
            }, output);

            const exitCode = await command.run({ environment: 'production' });
            const [ url, request ] = fetchMock.mock.getCall(0).arguments;

            assertEqual(0, exitCode);
            assertEqual(1, fetchMock.mock.callCount());
            assertEqual(
                'https://api.cloudflare.com/client/v4/accounts/account-id/workers/workers/production-worker',
                String(url),
            );
            assertEqual('PUT', request.method);
            assertEqual(JSON.stringify(workerConfig), request.body);
            assertEqual(`${ JSON.stringify(worker, null, 4) }\n`, output.chunks[0]);
        });
    });
});

function makeCommand(cloudflareConfig = { environments: {} }, output = captureOutput()) {
    return new CloudflareUpdateWorkerCommand({
        output,
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
