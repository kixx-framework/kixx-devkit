import { Buffer } from 'node:buffer';

import { describe } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
    assertNotMatches,
    assertUndefined,
} from 'kixx-assert';

import AdminAPIClient from '../../../../lib/admin/admin-api-client.js';

const ORIGIN = 'https://admin.example.test';
const EMAIL = 'root@example.test';
const PASSWORD = 'a-very-secret-password';
const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';


describe('admin/admin-api-client', ({ it }) => {
    it('lists migrations with Basic auth and returns each record', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(200, {
            data: [
                {
                    type: 'Migration',
                    id: '2026-07-17-example-noop',
                    attributes: { description: 'Example', status: 'pending' },
                },
            ],
        }));
        const client = makeClient(fetchMock);

        const migrations = await client.listMigrations();

        assertEqual(1, migrations.length);
        assertEqual('2026-07-17-example-noop', migrations[0].id);
        assertEqual('pending', migrations[0].status);
        assertEqual('/admin-api/v1/migrations', fetchMock.calls[0].url.pathname);
        assertEqual('GET', fetchMock.calls[0].init.method);
        assertEqual(basicAuthHeader(), fetchMock.calls[0].init.headers.authorization);
    });

    it('runs a migration batch sending only supplied attributes', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(200, {
            data: {
                type: 'MigrationRun',
                id: 'example-noop',
                attributes: {
                    done: true, cursor: null, stats: { scanned: 0 }, status: 'applied', dryRun: false,
                },
            },
        }));
        const client = makeClient(fetchMock);

        const result = await client.runMigration('example-noop', { dryRun: true });

        assertEqual(true, result.done);
        assertEqual('applied', result.status);
        assertEqual('/admin-api/v1/migrations/example-noop/run', fetchMock.calls[0].url.pathname);
        assertEqual('POST', fetchMock.calls[0].init.method);
        assertEqual(JSON_API_CONTENT_TYPE, fetchMock.calls[0].init.headers['content-type']);

        const resource = JSON.parse(fetchMock.calls[0].init.body).data;
        assertEqual('MigrationRun', resource.type);
        assertEqual(true, resource.attributes.dryRun);
        assertUndefined(resource.attributes.force);
        assertUndefined(resource.attributes.cursor);
    });

    it('URL-encodes the migration id in the request path', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(200, {
            data: { type: 'MigrationRun', id: 'a/b', attributes: {} },
        }));
        const client = makeClient(fetchMock);

        await client.runMigration('a/b', {});

        assertEqual('/admin-api/v1/migrations/a%2Fb/run', fetchMock.calls[0].url.pathname);
    });

    it('rejects a call passing both dryRun and force before issuing a request', async () => {
        const fetchMock = makeRecordingFetch();
        const client = makeClient(fetchMock);

        const caught = await catchAsyncError(() => {
            return client.runMigration('example-noop', { dryRun: true, force: true });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual(0, fetchMock.calls.length);
    });

    it('accepts an invite with a Bearer token and sends no Basic credentials', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(201, {
            data: {
                type: 'AdminUser',
                id: 'admin-id',
                attributes: {
                    emailAddress: 'new-admin@example.test',
                    userCreationDate: '2026-08-27T12:00:00.000Z',
                },
            },
        }));
        const client = makeClient(fetchMock);

        const account = await client.acceptInvite('invite-secret', {
            emailAddress: 'new-admin@example.test',
            password: 'at-least-16-characters-long',
        });

        assertEqual('admin-id', account.adminUserId);
        assertEqual('new-admin@example.test', account.emailAddress);
        assertEqual('Bearer invite-secret', fetchMock.calls[0].init.headers.authorization);

        const resource = JSON.parse(fetchMock.calls[0].init.body).data;
        assertEqual('AdminUser', resource.type);
    });

    it('creates a publishing API token and returns the one-time plaintext value', async () => {
        const fetchMock = makeRecordingFetch(() => makeResponse(201, {
            data: {
                type: 'PublishingApiToken',
                id: 'token-digest',
                attributes: {
                    token: 'kxpat_secret',
                    roles: [ 'editor' ],
                    description: 'CMS production deploy',
                    tokenCreationDate: '2026-08-27T12:00:00.000Z',
                    tokenExpirationDate: '2026-09-26T12:00:00.000Z',
                },
            },
        }));
        const client = makeClient(fetchMock);

        const token = await client.createPublishingApiToken({ description: 'CMS production deploy' });

        assertEqual('kxpat_secret', token.token);
        assertEqual('token-digest', token.tokenId);
        assertEqual('/admin-api/v1/publishing-api-tokens', fetchMock.calls[0].url.pathname);

        const resource = JSON.parse(fetchMock.calls[0].init.body).data;
        assertEqual('PublishingApiToken', resource.type);
        assertEqual('CMS production deploy', resource.attributes.description);
    });

    it('maps each protocol error code to its own error class', async () => {
        const cases = [
            [ 409, 'MigrationAlreadyAppliedError', 'MigrationAlreadyAppliedError' ],
            [ 409, 'MigrationCursorConflictError', 'MigrationCursorConflictError' ],
            [ 409, 'MigrationConcurrencyError', 'MigrationConcurrencyError' ],
            [ 401, 'InvalidCredentials', 'InvalidCredentialsError' ],
            [ 403, 'InvalidInvite', 'InvalidInviteError' ],
            [ 422, 'VALIDATION_ERROR', 'AdminApiError' ],
        ];

        for (const [ status, code, expectedName ] of cases) {
            const client = makeClient(async () => makeResponse(status, {
                errors: [ { status: String(status), code, detail: 'failed' } ],
            }));

            const caught = await catchAsyncError(() => client.listMigrations());

            assert(caught, `expected an error to be thrown for code ${ code }`);
            assertEqual(expectedName, caught.name);
            assertEqual(status, caught.status);
        }
    });

    it('retries a read request on 429 and on 5xx, and eventually raises', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            return makeResponse(503, { errors: [] });
        });

        const caught = await catchAsyncError(() => client.listMigrations());

        assertEqual(4, callCount);
        assertEqual(503, caught.status);
        assertEqual(4, caught.attempts);
    });

    it('retries a write request on 429 but not on 5xx', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            return makeResponse(503, { errors: [] });
        });

        const caught = await catchAsyncError(() => client.runMigration('example-noop', {}));

        assertEqual(1, callCount);
        assertEqual(503, caught.status);
    });

    it('retries a write request on 429 up to the attempt limit', async () => {
        let callCount = 0;
        const client = makeClient(async () => {
            callCount += 1;
            return makeResponse(429, { errors: [] });
        });

        const caught = await catchAsyncError(() => client.runMigration('example-noop', {}));

        assertEqual(4, callCount);
        assertEqual(429, caught.status);
    });

    it('retries read network failures and surfaces write network failures immediately', async () => {
        let readCalls = 0;
        const readClient = makeClient(async () => {
            readCalls += 1;
            throw new Error('network down');
        });
        await catchAsyncError(() => readClient.listMigrations());
        assertEqual(4, readCalls);

        let writeCalls = 0;
        const writeClient = makeClient(async () => {
            writeCalls += 1;
            throw new Error('network down');
        });
        await catchAsyncError(() => writeClient.runMigration('example-noop', {}));
        assertEqual(1, writeCalls);
    });

    it('redacts the password and invite token from error messages and error objects', async () => {
        const client = makeClient(async () => makeResponse(422, {
            errors: [
                { status: '422', code: 'VALIDATION_ERROR', detail: `Rejected ${ PASSWORD }` },
            ],
        }));

        const caught = await catchAsyncError(() => client.listMigrations());

        assertNotMatches(PASSWORD, caught.message);
        assertNotMatches(PASSWORD, JSON.stringify(caught.errors));
        assertMatches('[redacted]', caught.message);
    });

    it('redacts an echoed invite token from an accept-invite failure', async () => {
        const inviteToken = 'invite-secret-value';
        const client = makeClient(async () => makeResponse(403, {
            errors: [
                { status: '403', code: 'InvalidInvite', detail: `Rejected ${ inviteToken }` },
            ],
        }));

        const caught = await catchAsyncError(() => {
            return client.acceptInvite(inviteToken, {
                emailAddress: 'new-admin@example.test',
                password: 'at-least-16-characters-long',
            });
        });

        assertEqual('InvalidInviteError', caught.name);
        assertNotMatches(inviteToken, caught.message);
    });

    it('produces an AdminApiError instead of a runtime error for a malformed response', async () => {
        const client = makeClient(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            async text() {
                return 'not json';
            },
        }));

        const caught = await catchAsyncError(() => client.listMigrations());

        assert(caught, 'expected an error to be thrown');
        assertEqual('AdminApiError', caught.name);
    });
});

function makeClient(fetchImpl, options) {
    return new AdminAPIClient({
        origin: ORIGIN,
        email: EMAIL,
        password: PASSWORD,
        fetch: fetchImpl,
        wait: async () => {},
        random: () => 0,
        ...options,
    });
}

function basicAuthHeader() {
    return `Basic ${ Buffer.from(`${ EMAIL }:${ PASSWORD }`).toString('base64') }`;
}

function makeRecordingFetch(responder = () => makeResponse(200, { data: {} })) {
    const fetchMock = async (url, init) => {
        fetchMock.calls.push({ url, init });
        return await responder(url, init);
    };
    fetchMock.calls = [];
    return fetchMock;
}

function makeResponse(status, document) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
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
