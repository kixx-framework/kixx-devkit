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
    it('sends every stat request to its Publishing API endpoint', async () => {
        const fetchMock = makeRecordingFetch();
        const client = makeClient(fetchMock);

        await client.statStaticAsset('styles/site.css');
        await client.statGlobalTemplatePartials();
        await client.statBaseTemplates();
        await client.statPageMetadata('/');
        await client.statPagePartials('/about');
        await client.statPageIncludes('/about');
        await client.statPageTemplate('/about/page.html');
        await client.statEmailAssets('/welcome');

        assertEqual(
            [
                '/publishing-api/v1/index/static-asset/styles/site.css',
                '/publishing-api/v1/index/global-template-partials',
                '/publishing-api/v1/index/base-templates',
                '/publishing-api/v1/index/page-metadata/',
                '/publishing-api/v1/index/page-partials/about',
                '/publishing-api/v1/index/page-includes/about',
                '/publishing-api/v1/index/page-templates/about/page.html',
                '/publishing-api/v1/index/emails/welcome',
            ].join(','),
            fetchMock.calls.map(({ url }) => url.pathname).join(','),
        );

        for (const { init } of fetchMock.calls) {
            assertEqual('GET', init.method);
            assertEqual(`Bearer ${ TOKEN }`, init.headers.authorization);
        }
    });

    it('sends every upload shape and commits a complete content tree', async () => {
        const fetchMock = makeRecordingFetch(201);
        const client = makeClient(fetchMock);
        const binary = Uint8Array.from([ 1, 2, 3 ]).buffer;
        const templates = [ { id: 'main', source: '<main></main>' } ];
        const includes = { header: '<header></header>' };
        const email = { htmlTemplate: { id: 'html', source: '<p>Hello</p>' } };

        await client.uploadStaticAsset('image.bin', binary);
        await client.uploadGlobalTemplatePartials(templates);
        await client.uploadBaseTemplates(templates);
        await client.uploadPageMetadata('/', { title: 'Home' });
        await client.uploadPagePartials('/about', templates);
        await client.uploadPageIncludes('/about', includes);
        await client.uploadPageTemplate('/about/page.html', '<main>About</main>');
        await client.uploadEmailAssets('/welcome', email);
        await client.commitClosure('build-id', {
            staticAssets: { 'image.bin': { hash: 'hash', size: 3 } },
            pages: {},
            emails: {},
        });

        assertEqual(
            [
                '/publishing-api/v1/resources/static-asset/image.bin',
                '/publishing-api/v1/resources/global-template-partials',
                '/publishing-api/v1/resources/base-templates',
                '/publishing-api/v1/resources/page-metadata/',
                '/publishing-api/v1/resources/page-partials/about',
                '/publishing-api/v1/resources/page-includes/about',
                '/publishing-api/v1/resources/page-templates/about/page.html',
                '/publishing-api/v1/resources/emails/welcome',
                '/publishing-api/v1/index/closure',
            ].join(','),
            fetchMock.calls.map(({ url }) => url.pathname).join(','),
        );

        for (const { init } of fetchMock.calls) {
            assertEqual('PUT', init.method);
            assertEqual(`Bearer ${ TOKEN }`, init.headers.authorization);
        }

        const staticAsset = fetchMock.calls[0].init;
        assertEqual(binary, staticAsset.body);
        assertUndefined(staticAsset.headers['content-type']);

        assertJsonApiCall(fetchMock.calls[1], 'GlobalTemplatePartials', { bundle: templates });
        assertJsonApiCall(fetchMock.calls[2], 'BaseTemplates', { bundle: templates });
        assertJsonApiCall(fetchMock.calls[3], 'PageMetadata', { title: 'Home' });
        assertJsonApiCall(fetchMock.calls[4], 'PagePartials', { bundle: templates });
        assertJsonApiCall(fetchMock.calls[5], 'PageIncludes', { bundle: includes });

        const pageTemplate = fetchMock.calls[6].init;
        assertEqual('text/plain', pageTemplate.headers['content-type']);
        assertEqual('<main>About</main>', pageTemplate.body);

        assertJsonApiCall(fetchMock.calls[7], 'EmailAssets', email);
        const closure = parseJsonApiCall(fetchMock.calls[8]);
        assertEqual('ContentTree', closure.type);
        assertEqual('build-id', closure.attributes.buildId);
        assertEqual('hash', closure.attributes.staticAssets['image.bin'].hash);
    });

    it('returns resource attributes and treats a stat 404 as absent', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            if (callCount === 1) {
                return makeResponse(200, {
                    data: { type: 'StaticAsset', attributes: { hash: 'abc', size: 3 } },
                });
            }
            return makeResponse(404, { errors: [ { status: '404', detail: 'Not found' } ] });
        });

        const published = await client.statStaticAsset('image.bin');
        const absent = await client.statStaticAsset('missing.bin');

        assertEqual('abc', published.hash);
        assertEqual(3, published.size);
        assertEqual(null, absent);
    });

    it('retries 429 and 503 responses before succeeding', async () => {
        const statuses = [ 429, 503, 201 ];
        const waits = [];
        const fetchMock = async () => makeResponse(statuses.shift(), successDocument());
        const client = makeClient(fetchMock, {
            wait: async (milliseconds) => waits.push(milliseconds),
            random: () => 0.5,
        });

        const result = await client.uploadPageTemplate('/page.html', '<main></main>');

        assertEqual('hash', result.hash);
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

        const caught = await catchAsyncError(() => client.statBaseTemplates());

        assert(caught, 'expected an error to be thrown');
        assertEqual('PublishingApiError', caught.name);
        assertEqual(503, caught.status);
        assertEqual(4, caught.attempts);
        assertEqual(4, callCount);
    });

    it('retries network failures and raises without exposing their text', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            throw new Error(`network rejected ${ TOKEN }`);
        });

        const caught = await catchAsyncError(() => client.statBaseTemplates());

        assertEqual(4, callCount);
        assertEqual(null, caught.status);
        assertEqual(4, caught.attempts);
        assertNotMatches(TOKEN, caught.message);
        assertEqual(undefined, caught.cause);
    });

    it('raises immediately for 400 and 422 with every JSON:API error', async () => {
        for (const status of [ 400, 422 ]) {
            let callCount = 0;
            const client = makeClient(async () => {
                callCount += 1;
                return makeResponse(status, {
                    errors: [
                        {
                            status: String(status),
                            code: 'invalid-id',
                            detail: 'An id is required',
                            source: { pointer: '/data/attributes/bundle/0/id' },
                        },
                        {
                            status: String(status),
                            code: 'invalid-source',
                            detail: 'A source is required',
                            source: { pointer: '/data/attributes/bundle/0/source' },
                        },
                    ],
                });
            });

            const caught = await catchAsyncError(() => client.uploadGlobalTemplatePartials([]));

            assertEqual(1, callCount);
            assertEqual(status, caught.status);
            assertEqual(2, caught.errors.length);
            assertMatches('code invalid-id', caught.message);
            assertMatches('An id is required', caught.message);
            assertMatches('/data/attributes/bundle/0/id', caught.message);
            assertMatches('code invalid-source', caught.message);
            assertMatches('A source is required', caught.message);
        }
    });

    it('turns 401 and 403 into publishing-token instructions', async () => {
        for (const status of [ 401, 403 ]) {
            const client = makeClient(async () => makeResponse(status, { errors: [] }));

            const caught = await catchAsyncError(() => client.statBaseTemplates());

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

        const caught = await catchAsyncError(() => client.commitClosure('build-id', {}));

        assertNotMatches(TOKEN, caught.message);
        assertNotMatches(TOKEN, JSON.stringify(caught.errors));
        assertMatches('[redacted]', caught.message);
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

function makeRecordingFetch(status = 200) {
    const fetchMock = async (url, init) => {
        fetchMock.calls.push({ url, init });
        return makeResponse(status, successDocument());
    };
    fetchMock.calls = [];
    return fetchMock;
}

function makeResponse(status, document) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return JSON.stringify(document);
        },
    };
}

function successDocument() {
    return {
        data: {
            type: 'Resource',
            attributes: { hash: 'hash', size: 1 },
        },
    };
}

function assertJsonApiCall(call, type, attributes) {
    assertEqual(JSON_API_CONTENT_TYPE, call.init.headers['content-type']);
    const resource = parseJsonApiCall(call);
    assertEqual(type, resource.type);
    assertEqual(JSON.stringify(attributes), JSON.stringify(resource.attributes));
}

function parseJsonApiCall(call) {
    return JSON.parse(call.init.body).data;
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
