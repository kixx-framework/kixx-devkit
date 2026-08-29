import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { resolveResources } from '../../../../lib/cloudflare/provision-resources.js';
import CloudflareApiError from '../../../../lib/cloudflare/cloudflare-api-error.js';


describe('provision-resources', ({ it }) => {
    it('calls getKVNamespace() twice and getD1Database() once when every id is configured and valid', async () => {
        const apiClient = makeApiClient({
            getD1Database: async () => ({ uuid: 'database-id' }),
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const { resolved } = await resolveResources({
            environmentConfig: makeEnvironmentConfig(),
            apiClient,
        });

        assertEqual(0, resolved.length);
        assertEqual(1, apiClient.calls.getD1Database.length);
        assertEqual(2, apiClient.calls.getKVNamespace.length);
    });

    it('throws a UsageError naming the config key and id for a 404', async () => {
        const apiClient = makeApiClient({
            getD1Database: async () => {
                throw new CloudflareApiError('not found', { status: 404, method: 'GET', url: 'x' });
            },
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const caught = await catchAsyncError(() => {
            return resolveResources({ environmentConfig: makeEnvironmentConfig(), apiClient });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE.databaseId'), 'expected the message to name the config key');
        assert(caught.message.includes('database-id'), 'expected the message to name the id');
    });

    it('propagates a non-404 error unchanged', async () => {
        const authError = new CloudflareApiError('unauthorized', { status: 401, method: 'GET', url: 'x' });
        const apiClient = makeApiClient({
            getD1Database: async () => {
                throw authError;
            },
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const caught = await catchAsyncError(() => {
            return resolveResources({ environmentConfig: makeEnvironmentConfig(), apiClient });
        });

        assertEqual(authError, caught);
    });

    it('creates a resource with the configured name for a null id and reports it', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;

        const apiClient = makeApiClient({
            createD1Database: async (payload) => ({ uuid: 'new-database-id', name: payload.name }),
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const { resolved } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(1, resolved.length);
        assertEqual('DOCUMENT_STORE.databaseId', resolved[0].configKeyPath);
        assertEqual('new-database-id', resolved[0].id);
        assertEqual(true, resolved[0].created);
        assertEqual('example-database', apiClient.calls.createD1Database[0].name);
    });

    it('adopts an existing D1 database by name instead of creating a duplicate', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;

        const apiClient = makeApiClient({
            findD1DatabaseByName: async (name) => ({ uuid: 'existing-database-id', name }),
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const { resolved } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(1, resolved.length);
        assertEqual('existing-database-id', resolved[0].id);
        assertEqual(false, resolved[0].created);
        assertEqual(0, apiClient.calls.createD1Database.length);
        assertEqual('example-database', apiClient.calls.findD1DatabaseByName[0]);
    });

    it('adopts an existing KV namespace by name instead of creating a duplicate', async () => {
        const config = makeEnvironmentConfig();
        config.KEY_VALUE_STORE.namespaceId = null;

        const apiClient = makeApiClient({
            getD1Database: async () => ({ uuid: 'database-id' }),
            getKVNamespace: async () => ({ id: 'namespace-id' }),
            findKVNamespaceByName: async (title) => ({ id: 'existing-namespace-id', title }),
        });

        const { resolved } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(1, resolved.length);
        assertEqual('existing-namespace-id', resolved[0].id);
        assertEqual(false, resolved[0].created);
        assertEqual(0, apiClient.calls.createKVNamespace.length);
        assertEqual('example-namespace', apiClient.calls.findKVNamespaceByName[0]);
    });

    it('looks the name up before every create', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;
        config.KEY_VALUE_STORE.namespaceId = null;
        config.CONTENT_STORE.kvNamespaceId = null;

        const apiClient = makeApiClient({});

        const { resolved } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(3, resolved.length);
        assertEqual(1, apiClient.calls.findD1DatabaseByName.length);
        assertEqual(2, apiClient.calls.findKVNamespaceByName.length);
        assertEqual(1, apiClient.calls.createD1Database.length);
        assertEqual(2, apiClient.calls.createKVNamespace.length);
    });

    it('translates a duplicate-name rejection into a UsageError naming the config key', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;

        const apiClient = makeApiClient({
            createD1Database: async () => {
                throw new CloudflareApiError('Unexpected HTTP status 400 from POST', {
                    status: 400,
                    errors: [ { code: 7502, message: "Database with name: 'example-database' already exists" } ],
                    method: 'POST',
                    url: 'x',
                });
            },
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const caught = await catchAsyncError(() => resolveResources({ environmentConfig: config, apiClient }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE.databaseId'), 'expected the message to name the config key');
        assert(caught.message.includes('example-database'), 'expected the message to name the resource');
        assertEqual('CloudflareApiError', caught.cause.name);
    });

    it('translates a duplicate KV namespace title by its error message', async () => {
        const config = makeEnvironmentConfig();
        config.KEY_VALUE_STORE.namespaceId = null;

        const apiClient = makeApiClient({
            getD1Database: async () => ({ uuid: 'database-id' }),
            getKVNamespace: async () => ({ id: 'namespace-id' }),
            createKVNamespace: async () => {
                throw new CloudflareApiError('Unexpected HTTP status 400 from POST', {
                    status: 400,
                    errors: [ { code: 10014, message: 'a namespace with this account ID and title already exists' } ],
                    method: 'POST',
                    url: 'x',
                });
            },
        });

        const caught = await catchAsyncError(() => resolveResources({ environmentConfig: config, apiClient }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('KEY_VALUE_STORE.namespaceId'), 'expected the message to name the config key');
    });

    it('propagates an unrelated create failure unchanged', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;

        const quotaError = new CloudflareApiError('over quota', {
            status: 400,
            errors: [ { code: 7400, message: 'account limit reached' } ],
            method: 'POST',
            url: 'x',
        });
        const apiClient = makeApiClient({
            createD1Database: async () => {
                throw quotaError;
            },
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const caught = await catchAsyncError(() => resolveResources({ environmentConfig: config, apiClient }));

        assertEqual(quotaError, caught);
    });

    it('reports three resolved resources from one call', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;
        config.KEY_VALUE_STORE.namespaceId = null;
        config.CONTENT_STORE.kvNamespaceId = null;

        const apiClient = makeApiClient({
            createD1Database: async () => ({ uuid: 'database-id' }),
            createKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const { resolved } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(3, resolved.length);
    });

    it('makes no calls and reports nothing for an absent config block', async () => {
        const apiClient = makeApiClient({});

        const { resolved } = await resolveResources({ environmentConfig: {}, apiClient });

        assertEqual(0, resolved.length);
        assertEqual(0, apiClient.calls.getD1Database.length);
        assertEqual(0, apiClient.calls.getKVNamespace.length);
        assertEqual(0, apiClient.calls.createD1Database.length);
        assertEqual(0, apiClient.calls.createKVNamespace.length);
    });

    it('throws when a present block with a null id is missing its name field', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE = { databaseId: null };

        const apiClient = makeApiClient({});

        const caught = await catchAsyncError(() => resolveResources({ environmentConfig: config, apiClient }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('databaseName'), 'expected the message to name the missing field');
        assertEqual(0, apiClient.calls.createD1Database.length);
    });

    it('never calls an R2 method', async () => {
        const apiClient = makeApiClient({
            getD1Database: async () => ({ uuid: 'database-id' }),
            getKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        await resolveResources({ environmentConfig: makeEnvironmentConfig(), apiClient });

        assert(!apiClient.createBucket, 'expected no R2 method on the client');
    });
});

function makeEnvironmentConfig() {
    return {
        DOCUMENT_STORE: { databaseName: 'example-database', databaseId: 'database-id' },
        KEY_VALUE_STORE: { namespaceName: 'example-namespace', namespaceId: 'namespace-id' },
        CONTENT_STORE: {
            kvNamespaceName: 'example-content-namespace',
            kvNamespaceId: 'content-namespace-id',
            durableObjectBindingName: 'CONTENT_STORE_DO',
            durableObjectClassName: 'ContentAddressableIndexStore',
        },
    };
}

function makeApiClient(implementations) {
    const calls = {
        getD1Database: [],
        getKVNamespace: [],
        findD1DatabaseByName: [],
        findKVNamespaceByName: [],
        createD1Database: [],
        createKVNamespace: [],
    };

    const client = {
        async getD1Database(id) {
            calls.getD1Database.push(id);
            return implementations.getD1Database ? implementations.getD1Database(id) : { uuid: id };
        },
        async getKVNamespace(id) {
            calls.getKVNamespace.push(id);
            return implementations.getKVNamespace ? implementations.getKVNamespace(id) : { id };
        },
        // The default is "no such resource", so a test that does not opt in
        // exercises the create path.
        async findD1DatabaseByName(name) {
            calls.findD1DatabaseByName.push(name);
            return implementations.findD1DatabaseByName ? implementations.findD1DatabaseByName(name) : null;
        },
        async findKVNamespaceByName(title) {
            calls.findKVNamespaceByName.push(title);
            return implementations.findKVNamespaceByName ? implementations.findKVNamespaceByName(title) : null;
        },
        async createD1Database(payload) {
            calls.createD1Database.push(payload);
            return implementations.createD1Database
                ? implementations.createD1Database(payload)
                : { uuid: 'created-database-id' };
        },
        async createKVNamespace(payload) {
            calls.createKVNamespace.push(payload);
            return implementations.createKVNamespace
                ? implementations.createKVNamespace(payload)
                : { id: 'created-namespace-id' };
        },
    };

    return Object.assign(client, { calls });
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
