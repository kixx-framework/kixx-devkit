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

        const { created } = await resolveResources({
            environmentConfig: makeEnvironmentConfig(),
            apiClient,
        });

        assertEqual(0, created.length);
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

        const { created } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(1, created.length);
        assertEqual('DOCUMENT_STORE.databaseId', created[0].configKeyPath);
        assertEqual('new-database-id', created[0].id);
        assertEqual('example-database', apiClient.calls.createD1Database[0].name);
    });

    it('reports three created resources from one call', async () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;
        config.KEY_VALUE_STORE.namespaceId = null;
        config.CONTENT_STORE.kvNamespaceId = null;

        const apiClient = makeApiClient({
            createD1Database: async () => ({ uuid: 'database-id' }),
            createKVNamespace: async () => ({ id: 'namespace-id' }),
        });

        const { created } = await resolveResources({ environmentConfig: config, apiClient });

        assertEqual(3, created.length);
    });

    it('makes no calls and reports nothing for an absent config block', async () => {
        const apiClient = makeApiClient({});

        const { created } = await resolveResources({ environmentConfig: {}, apiClient });

        assertEqual(0, created.length);
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
