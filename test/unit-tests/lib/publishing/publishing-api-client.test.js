import { describe } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
    assertNotMatches,
    assertUndefined,
} from 'kixx-assert';

import PublishingAPIClient from '../../../../lib/publishing/publishing-api-client.js';

const ORIGIN = 'https://app.example.test';
const TOKEN = 'publishing-secret';
const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';


describe('publishing/publishing-api-client', ({ it }) => {
    it('discovers publishing capabilities without making a write', async () => {
        const capabilities = {
            runningBuildId: 'production',
            contentContractVersion: 1,
            addressingFormat: 3,
            limits: {
                maxObjectBytes: 26_214_400,
                maxObjectStatusIds: 100,
                maxManifestEntries: 10_000,
                maxInlineContentBytes: 262_144,
            },
        };
        const fetchMock = makeRecordingFetch(() => makeResponse(200, {
            data: { type: 'PublishingApi', id: 'v1', attributes: capabilities },
        }));
        const client = makeClient(fetchMock);

        const result = await client.discover();

        assertEqual(JSON.stringify(capabilities), JSON.stringify(result));
        assertEqual('/publishing-api/v1/', fetchMock.calls[0].url.pathname);
        assertEqual('GET', fetchMock.calls[0].init.method);
        assertEqual(`Bearer ${ TOKEN }`, fetchMock.calls[0].init.headers.authorization);
    });

    it('deduplicates and batches object status requests using the discovered limit', async () => {
        const requestedIds = Array.from({ length: 205 }, (_, index) => `object-${ index }`);
        const fetchMock = makeRecordingFetch((_url, init) => {
            const ids = JSON.parse(init.body).data.attributes.objectIds;
            return makeResponse(200, {
                data: ids
                    .filter((_id, index) => index % 2 === 0)
                    .reverse()
                    .map((id) => ({
                        type: 'Object',
                        id,
                        attributes: { size: id.length },
                    })),
            });
        });
        const client = makeClient(fetchMock);

        const stored = await client.getObjectStatus(
            [ ...requestedIds, 'object-0', 'object-100' ],
            { maxObjectStatusIds: 100 },
        );

        assertEqual(3, fetchMock.calls.length);
        assertEqual('100,100,5', fetchMock.calls.map((call) => {
            return JSON.parse(call.init.body).data.attributes.objectIds.length;
        }).join(','));
        assertEqual(103, stored.length);
        const storedIds = new Set(stored.map(({ objectId }) => objectId));
        assert(storedIds.has('object-0'));
        assert(storedIds.has('object-204'));
        assert(!storedIds.has('object-1'));

        const sentIds = fetchMock.calls.flatMap((call) => {
            assertEqual('/publishing-api/v1/objects/status', call.url.pathname);
            assertEqual('POST', call.init.method);
            assertEqual(JSON_API_CONTENT_TYPE, call.init.headers['content-type']);
            return JSON.parse(call.init.body).data.attributes.objectIds;
        });
        assertEqual(205, new Set(sentIds).size);
    });

    it('returns an empty status without sending an empty request', async () => {
        const fetchMock = makeRecordingFetch();
        const client = makeClient(fetchMock);

        const stored = await client.getObjectStatus([], { maxObjectStatusIds: 100 });

        assertEqual(0, stored.length);
        assertEqual(0, fetchMock.calls.length);
    });

    it('uploads raw bytes and distinguishes created from already present', async () => {
        const statuses = [ 201, 200 ];
        const fetchMock = makeRecordingFetch((url, init) => makeResponse(statuses.shift(), {
            data: {
                type: 'Object',
                id: decodeURIComponent(url.pathname.split('/').at(-1)),
                attributes: { size: typeof init.body === 'string' ? 5 : init.body.byteLength },
            },
        }));
        const client = makeClient(fetchMock);
        const binary = Uint8Array.from([ 1, 2, 3 ]).buffer;

        const created = await client.uploadObject('text/id', 'hello', { maxObjectBytes: 5 });
        const present = await client.uploadObject('binary-id', binary, { maxObjectBytes: 3 });

        assertEqual('text/id', created.objectId);
        assertEqual(5, created.size);
        assertEqual(true, created.created);
        assertEqual(false, present.created);
        assertEqual(binary, fetchMock.calls[1].init.body);
        assertUndefined(fetchMock.calls[0].init.headers['content-type']);
        assertEqual('/publishing-api/v1/objects/text%2Fid', fetchMock.calls[0].url.pathname);
    });

    it('rejects an oversized object before sending a request', async () => {
        const fetchMock = makeRecordingFetch();
        const client = makeClient(fetchMock);

        const caught = await catchAsyncError(() => {
            return client.uploadObject('object-id', 'hello', { maxObjectBytes: 4 });
        });

        assert(caught, 'expected an error to be thrown');
        assertMatches('5 bytes', caught.message);
        assertMatches('4 bytes', caught.message);
        assertEqual(0, fetchMock.calls.length);
    });

    it('retries 429 and 503 responses before succeeding', async () => {
        const statuses = [ 429, 503, 201 ];
        const waits = [];
        const client = makeClient(async () => makeObjectResponse(statuses.shift()), {
            wait: async (milliseconds) => waits.push(milliseconds),
            random: () => 0.5,
        });

        const result = await client.uploadObject('object-id', 'x', { maxObjectBytes: 1 });

        assertEqual(true, result.created);
        assertEqual(2, waits.length);
        assertEqual(100, waits[0]);
        assertEqual(200, waits[1]);
    });

    it('raises after the fourth retryable response', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            return makeResponse(503, { errors: [ { status: '503', detail: 'Unavailable' } ] });
        });

        const caught = await catchAsyncError(() => client.discover());

        assert(caught, 'expected an error to be thrown');
        assertEqual('PublishingApiError', caught.name);
        assertEqual(503, caught.status);
        assertEqual(4, caught.attempts);
        assertEqual(4, callCount);
    });

    it('retries network failures without exposing their text', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            throw new Error(`network rejected ${ TOKEN }`);
        });

        const caught = await catchAsyncError(() => client.discover());

        assertEqual(4, callCount);
        assertEqual(null, caught.status);
        assertEqual(4, caught.attempts);
        assertNotMatches(TOKEN, caught.message);
        assertEqual(undefined, caught.cause);
    });

    it('raises immediately for object protocol errors', async () => {
        for (const [ status, code ] of [
            [ 413, 'PAYLOAD_TOO_LARGE_ERROR' ],
            [ 422, 'ObjectIdMismatch' ],
            [ 422, 'ObjectIdInvalid' ],
        ]) {
            let callCount = 0;
            const client = makeClient(async () => {
                callCount += 1;
                return makeResponse(status, {
                    errors: [ { status: String(status), code, detail: `Rejected ${ code }` } ],
                });
            });

            const caught = await catchAsyncError(() => {
                return client.uploadObject('object-id', 'x', { maxObjectBytes: 1 });
            });

            assertEqual(1, callCount);
            assertEqual(status, caught.status);
            assertEqual(code, caught.errors[0].code);
            assertMatches(`code ${ code }`, caught.message);
        }
    });

    it('turns 401 and 403 into publishing-token instructions', async () => {
        for (const status of [ 401, 403 ]) {
            const client = makeClient(async () => makeResponse(status, { errors: [] }));

            const caught = await catchAsyncError(() => client.discover());

            assertMatches('.kixx/secrets.json', caught.message);
            assertMatches('app.environments.<environment>.publishingToken', caught.message);
        }
    });

    it('redacts the token from response text and structured errors', async () => {
        const client = makeClient(async () => makeResponse(422, {
            errors: [
                { status: '422', code: 'echo', detail: `Rejected ${ TOKEN }` },
            ],
        }));

        const caught = await catchAsyncError(() => {
            return client.uploadObject('object-id', 'x', { maxObjectBytes: 1 });
        });

        assertNotMatches(TOKEN, caught.message);
        assertNotMatches(TOKEN, JSON.stringify(caught.errors));
        assertMatches('[redacted]', caught.message);
    });

    it('creates byte-identical Releases without an idempotency key', async () => {
        const release = {
            type: 'Release',
            id: 'release-id',
            attributes: { objectCount: 2, totalBytes: 12, contractVersion: 1 },
        };
        const fetchMock = makeRecordingFetch(() => makeResponse(201, { data: release }));
        const client = makeClient(fetchMock);
        const manifest = { staticAssets: {}, pages: {}, emails: {} };

        const first = await client.createRelease(manifest, { client: 'devkit' });
        const second = await client.createRelease(manifest, { client: 'devkit' });

        assertEqual('release-id', first.releaseId);
        assertEqual('release-id', second.releaseId);
        assertEqual(2, first.objectCount);
        for (const call of fetchMock.calls) {
            assertEqual('POST', call.init.method);
            assertEqual('/publishing-api/v1/releases', call.url.pathname);
            assertUndefined(call.init.headers['idempotency-key']);
            const resource = JSON.parse(call.init.body).data;
            assertEqual('Release', resource.type);
            assertEqual(JSON.stringify(manifest), JSON.stringify(resource.attributes.manifest));
        }
    });

    it('validates stored-object manifests and rejects inline content locally', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(200, {
            data: {
                type: 'ReleaseValidation',
                id: 'release-id',
                attributes: { objectCount: 1, totalBytes: 4, contractVersion: 1 },
            },
        }));
        const client = makeClient(fetchMock);
        const manifest = {
            staticAssets: { 'site.css': { objectId: 'object-id', size: 4 } },
            pages: {},
            emails: {},
        };

        const result = await client.validateRelease(manifest);
        const caught = await catchAsyncError(() => client.validateRelease({
            staticAssets: { 'site.css': { content: 'body {}' } },
        }));

        assertEqual('release-id', result.releaseId);
        assertEqual(1, fetchMock.calls.length);
        assertEqual('/publishing-api/v1/releases/validation', fetchMock.calls[0].url.pathname);
        assertMatches('does not accept inline content', caught.message);
    });

    it('gets Release metadata and its complete manifest', async () => {
        const fetchMock = makeRecordingFetch((url) => {
            if (url.pathname.endsWith('/manifest')) {
                return makeResponse(200, {
                    data: {
                        type: 'ReleaseManifest',
                        id: 'release/id',
                        attributes: { manifest: { staticAssets: {}, pages: {}, emails: {} } },
                    },
                });
            }
            return makeResponse(200, {
                data: {
                    type: 'Release',
                    id: 'release/id',
                    attributes: { objectCount: 0 },
                },
            });
        });
        const client = makeClient(fetchMock);

        const release = await client.getRelease('release/id');
        const manifest = await client.getReleaseManifest('release/id');

        assertEqual('release/id', release.releaseId);
        assertEqual(0, release.objectCount);
        assertEqual(0, Object.keys(manifest.staticAssets).length);
        assertEqual('/publishing-api/v1/releases/release%2Fid', fetchMock.calls[0].url.pathname);
        assertEqual(
            '/publishing-api/v1/releases/release%2Fid/manifest',
            fetchMock.calls[1].url.pathname,
        );
    });

    it('threads pagination through Release and activation history', async () => {
        const fetchMock = makeRecordingFetch((url) => {
            if (url.pathname.endsWith('/activations')) {
                return makeResponse(200, {
                    data: [ {
                        type: 'Activation',
                        id: 'activation-id',
                        attributes: { buildId: 'build/id', toReleaseId: 'release-id' },
                    } ],
                    meta: { cursor: 'activation-next' },
                });
            }
            return makeResponse(200, {
                data: [ {
                    type: 'Release',
                    id: 'release-id',
                    attributes: { objectCount: 1 },
                } ],
                meta: { cursor: 'release-next' },
            });
        });
        const client = makeClient(fetchMock);

        const releases = await client.listReleases({ limit: 25, cursor: 'release cursor' });
        const activations = await client.getBuildActivations(
            'build/id',
            { limit: 10, cursor: 'activation cursor' },
        );

        assertEqual('release-next', releases.cursor);
        assertEqual('release-id', releases.releases[0].releaseId);
        assertEqual('activation-next', activations.cursor);
        assertEqual('activation-id', activations.activations[0].activationId);
        assertEqual('?limit=25&cursor=release+cursor', fetchMock.calls[0].url.search);
        assertEqual('?limit=10&cursor=activation+cursor', fetchMock.calls[1].url.search);
    });

    it('lists builds and gets a build with its ETag', async () => {
        const buildResource = {
            type: 'Build',
            id: 'production',
            attributes: { releaseId: 'release-id', assignedAt: '2026-09-01T00:00:00.000Z' },
        };
        const fetchMock = makeRecordingFetch((url) => {
            return url.pathname.endsWith('/builds')
                ? makeResponse(200, { data: [ buildResource ] })
                : makeResponse(200, { data: buildResource }, { etag: '"release-id"' });
        });
        const client = makeClient(fetchMock);

        const builds = await client.listBuilds();
        const build = await client.getBuild('production');

        assertEqual('production', builds[0].buildId);
        assertEqual('release-id', build.releaseId);
        assertEqual('"release-id"', build.etag);
    });

    it('assigns a build with exactly one pointer precondition', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(200, {
            data: {
                type: 'Build',
                id: 'production',
                attributes: { releaseId: 'new-release', assignedAt: 'now' },
            },
        }, { etag: '"new-release"' }));
        const client = makeClient(fetchMock);

        const matched = await client.assignBuild(
            'production',
            'new-release',
            { ifMatch: '"old-release"', reason: 'rollback' },
        );
        await client.assignBuild(
            'production',
            'new-release',
            { ifNoneMatch: '*' },
        );

        assertEqual('"new-release"', matched.etag);
        assertEqual('"old-release"', fetchMock.calls[0].init.headers['if-match']);
        assertUndefined(fetchMock.calls[0].init.headers['if-none-match']);
        assertEqual('*', fetchMock.calls[1].init.headers['if-none-match']);
        const resource = JSON.parse(fetchMock.calls[0].init.body).data;
        assertEqual('production', resource.id);
        assertEqual('new-release', resource.attributes.releaseId);
        assertEqual('rollback', resource.attributes.reason);
    });

    it('rejects both or neither build precondition locally', async () => {
        const fetchMock = makeRecordingFetch();
        const client = makeClient(fetchMock);

        const neither = await catchAsyncError(() => {
            return client.assignBuild('build-id', 'release-id', {});
        });
        const both = await catchAsyncError(() => {
            return client.assignBuild('build-id', 'release-id', {
                ifMatch: '"release-id"',
                ifNoneMatch: '*',
            });
        });

        assertMatches('exactly one', neither.message);
        assertMatches('exactly one', both.message);
        assertEqual(0, fetchMock.calls.length);
    });

    it('surfaces build protocol failures as distinct error classes', async () => {
        for (const [ status, code, expectedName ] of [
            [ 404, 'BuildNotFound', 'BuildNotFoundError' ],
            [ 404, 'ReleaseNotFound', 'ReleaseNotFoundError' ],
            [ 412, 'BuildPointerConflict', 'BuildPointerConflictError' ],
            [ 422, 'InvalidBuildAssignment', 'InvalidBuildAssignmentError' ],
            [ 428, 'PreconditionRequired', 'PreconditionRequiredError' ],
        ]) {
            const client = makeClient(async () => makeResponse(status, {
                errors: [ { status: String(status), code, detail: code } ],
            }));

            const caught = await catchAsyncError(() => {
                return client.assignBuild('build-id', 'release-id', { ifNoneMatch: '*' });
            });

            assertEqual(expectedName, caught.name);
            assertEqual(status, caught.status);
            assertEqual(1, caught.attempts);
        }
    });
});

function makeClient(fetchImpl, options) {
    return new PublishingAPIClient({
        origin: ORIGIN,
        token: TOKEN,
        fetch: fetchImpl,
        wait: async () => {},
        random: () => 0,
        ...options,
    });
}

function makeRecordingFetch(responder = () => makeObjectResponse(200)) {
    const fetchMock = async (url, init) => {
        fetchMock.calls.push({ url, init });
        return await responder(url, init);
    };
    fetchMock.calls = [];
    return fetchMock;
}

function makeObjectResponse(status) {
    return makeResponse(status, {
        data: {
            type: 'Object',
            id: 'object-id',
            attributes: { size: 1 },
        },
    });
}

function makeResponse(status, document, headers) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return headers?.[name.toLowerCase()] ?? null;
            },
        },
        async text() {
            return JSON.stringify(document);
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
