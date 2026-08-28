import { describe, MockTracker } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';
import CloudflareAPIClient from '../../../../lib/cloudflare/cloudflare-api-client.js';


describe('CloudflareAPIClient', ({ it }) => {
    it('creates a Worker with authentication and a JSON request body', async () => {
        await withMockTracker(async (tracker) => {
            const worker = { id: 'worker-id', name: 'example-worker' };
            const fetchMock = tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({ success: true, result: worker });
            });
            const client = makeClient();

            const result = await client.createWorker({ name: 'example-worker' });

            assertEqual(worker, result);
            assertEqual(1, fetchMock.mock.callCount());

            const call = fetchMock.mock.getCall(0);
            const url = call.arguments[0];
            const init = call.arguments[1];

            assertEqual(
                'https://api.cloudflare.com/client/v4/accounts/account-id/workers/workers',
                url.href,
            );
            assertEqual('POST', init.method);
            assertEqual('Bearer api-token', init.headers.authorization);
            assertEqual('application/json', init.headers['content-type']);
            assertEqual('example-worker', JSON.parse(init.body).name);
        });
    });

    it('uses default pagination when listing Worker versions', async () => {
        await withMockTracker(async (tracker) => {
            const fetchMock = tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({ success: true, result: [] });
            });
            const client = makeClient();

            await client.listWorkerVersions('example-worker');

            const call = fetchMock.mock.getCall(0);
            const url = call.arguments[0];

            assertEqual('1', url.searchParams.get('page'));
            assertEqual('3', url.searchParams.get('per_page'));
            assertEqual('GET', call.arguments[1].method);
        });
    });

    it('preserves an explicit false deploy option', async () => {
        await withMockTracker(async (tracker) => {
            const fetchMock = tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({ success: true, result: {} });
            });
            const client = makeClient();

            await client.createWorkerVersion(
                'example-worker',
                { main_module: 'index.js' },
                { deploy: false },
            );

            const call = fetchMock.mock.getCall(0);
            const url = call.arguments[0];

            assertEqual('false', url.searchParams.get('deploy'));
        });
    });

    it('serializes a parameterized D1 query', async () => {
        await withMockTracker(async (tracker) => {
            const queryResult = [ { results: [ { id: 'one' } ], success: true } ];
            const fetchMock = tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({ success: true, result: queryResult });
            });
            const client = makeClient();

            const result = await client.queryD1Database('database-id', {
                sql: 'SELECT * FROM widgets WHERE id = ?',
                params: [ 'one' ],
            });

            assertEqual(queryResult, result);

            const call = fetchMock.mock.getCall(0);
            const url = call.arguments[0];
            const init = call.arguments[1];
            const body = JSON.parse(init.body);

            assertEqual(
                'https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query',
                url.href,
            );
            assertEqual('POST', init.method);
            assertEqual('SELECT * FROM widgets WHERE id = ?', body.sql);
            assertEqual(1, body.params.length);
            assertEqual('one', body.params[0]);
        });
    });

    it('rejects an explicitly unsuccessful D1 result entry', async () => {
        await withMockTracker(async (tracker) => {
            tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({
                    success: true,
                    result: [ { error: 'query failed', success: false } ],
                });
            });
            const client = makeClient();

            const caught = await catchAsyncError(() => {
                return client.queryD1Database('database-id', { sql: 'SELECT 1' });
            });

            assert(caught, 'expected an error to be thrown');
            assertMatches('Unsuccessful D1 query result from POST', caught.message);
        });
    });

    it('reports non-successful HTTP responses with response details', async () => {
        await withMockTracker(async (tracker) => {
            tracker.method(globalThis, 'fetch', async () => {
                return makeHttpErrorResponse(403, 'permission denied');
            });
            const client = makeClient();

            const caught = await catchAsyncError(() => client.getWorker('example-worker'));

            assert(caught, 'expected an error to be thrown');
            assertMatches('Unexpected HTTP status 403 from GET', caught.message);
            assertMatches('permission denied', caught.message);
        });
    });

    it('reports the first Cloudflare API error message', async () => {
        await withMockTracker(async (tracker) => {
            tracker.method(globalThis, 'fetch', async () => {
                return makeApiResponse({
                    success: false,
                    errors: [ { message: 'invalid API token' } ],
                    result: null,
                });
            });
            const client = makeClient();

            const caught = await catchAsyncError(() => client.getWorker('example-worker'));

            assert(caught, 'expected an error to be thrown');
            assertMatches('API error "invalid API token" from GET', caught.message);
        });
    });
});

function makeClient() {
    return new CloudflareAPIClient({
        accountId: 'account-id',
        apiToken: 'api-token',
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

function makeHttpErrorResponse(status, body) {
    return {
        ok: false,
        status,
        async text() {
            return body;
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
