import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { buildWorkerBindings } from '../../../../lib/cloudflare/worker-bindings.js';
import CloudflareWorkerVersion from '../../../../lib/cloudflare/cloudflare-worker-version.js';


describe('worker-bindings', ({ it }) => {
    it('produces the expected binding set from a full sample environment', () => {
        const bindings = buildWorkerBindings({
            environmentConfig: makeEnvironmentConfig(),
            secrets: { API_SECRET: 'shh' },
        });

        const byType = groupByType(bindings);

        assertEqual(1, byType.d1.length);
        assertEqual(2, byType.kv_namespace.length);
        assertEqual(1, byType.durable_object_namespace.length);
        assertEqual(1, byType.r2_bucket.length);
        assertEqual(2, byType.plain_text.length);
        assertEqual(1, byType.secret_text.length);
    });

    it('never includes BUILD_ID even with unrelated ENVARS and secrets', () => {
        const bindings = buildWorkerBindings({
            environmentConfig: makeEnvironmentConfig(),
            secrets: { API_SECRET: 'shh' },
        });

        assert(!bindings.some((binding) => binding.name === 'BUILD_ID'), 'expected no BUILD_ID binding');
    });

    it('produces no r2_bucket bindings for an empty buckets array', () => {
        const config = makeEnvironmentConfig();
        config.OBJECT_STORE = { buckets: {} };

        const bindings = buildWorkerBindings({ environmentConfig: config, secrets: {} });

        assert(!bindings.some((binding) => binding.type === 'r2_bucket'), 'expected no r2_bucket bindings');
    });

    it('omits every block independently and returns an empty array when all are absent', () => {
        const bindings = buildWorkerBindings({ environmentConfig: {}, secrets: {} });

        assertEqual(0, bindings.length);
    });

    it('throws a UsageError naming the config path for a missing required field', () => {
        const config = makeEnvironmentConfig();
        delete config.DOCUMENT_STORE.bindingName;

        const caught = catchError(() => buildWorkerBindings({ environmentConfig: config, secrets: {} }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE.bindingName'), 'expected the message to name the path');
    });

    it('throws when a resource id is null', () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;

        const caught = catchError(() => buildWorkerBindings({ environmentConfig: config, secrets: {} }));

        assert(caught, 'expected an error to be thrown');
    });

    it('throws a UsageError naming the key and type for a non-string ENVARS value', () => {
        const config = makeEnvironmentConfig();
        config.ENVARS.LOG_LEVEL = 5;

        const caught = catchError(() => buildWorkerBindings({ environmentConfig: config, secrets: {} }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('LOG_LEVEL'), 'expected the message to name the key');
        assert(caught.message.includes('number'), 'expected the message to name the type');
    });

    it('throws when ENVARS declares BUILD_ID', () => {
        const config = makeEnvironmentConfig();
        config.ENVARS.BUILD_ID = 'nope';

        const caught = catchError(() => buildWorkerBindings({ environmentConfig: config, secrets: {} }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });

    it('throws naming both sources for a name in both ENVARS and secrets', () => {
        const config = makeEnvironmentConfig();
        config.ENVARS.API_SECRET = 'in-envars';

        const caught = catchError(() => {
            return buildWorkerBindings({ environmentConfig: config, secrets: { API_SECRET: 'in-dotenv' } });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('ENVARS'), 'expected the message to name ENVARS');
        assert(caught.message.includes('.env'), 'expected the message to name .env');
    });

    it('throws naming both sources for a duplicate name across two config blocks', () => {
        const config = makeEnvironmentConfig();
        config.KEY_VALUE_STORE.bindingName = config.DOCUMENT_STORE.bindingName;

        const caught = catchError(() => buildWorkerBindings({ environmentConfig: config, secrets: {} }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE'), 'expected the message to name DOCUMENT_STORE');
        assert(caught.message.includes('KEY_VALUE_STORE'), 'expected the message to name KEY_VALUE_STORE');
    });

    it('sorts the result by name regardless of input key order', () => {
        const config = makeEnvironmentConfig();

        const bindingsOne = buildWorkerBindings({ environmentConfig: config, secrets: { API_SECRET: 'shh' } });

        const reordered = {
            ENVARS: config.ENVARS,
            OBJECT_STORE: config.OBJECT_STORE,
            CONTENT_STORE: config.CONTENT_STORE,
            KEY_VALUE_STORE: config.KEY_VALUE_STORE,
            DOCUMENT_STORE: config.DOCUMENT_STORE,
        };
        const bindingsTwo = buildWorkerBindings({ environmentConfig: reordered, secrets: { API_SECRET: 'shh' } });

        assertEqual(JSON.stringify(bindingsOne), JSON.stringify(bindingsTwo));

        const names = bindingsOne.map((binding) => binding.name);
        const sortedNames = names.slice().sort();
        assertEqual(sortedNames.join(','), names.join(','));
    });

    it('produces a secret_text binding with an empty text for an empty-string secret', () => {
        const bindings = buildWorkerBindings({
            environmentConfig: {},
            secrets: { EMPTY_SECRET: '' },
        });

        assertEqual(1, bindings.length);
        assertEqual('secret_text', bindings[0].type);
        assertEqual('', bindings[0].text);
    });

    it('produces bindings every one of which CloudflareWorkerVersion#addBinding() accepts', () => {
        const bindings = buildWorkerBindings({
            environmentConfig: makeEnvironmentConfig(),
            secrets: { API_SECRET: 'shh' },
        });

        const version = new CloudflareWorkerVersion();

        for (const binding of bindings) {
            version.addBinding(binding);
        }

        assert(true, 'expected no binding to be rejected');
    });
});

function makeEnvironmentConfig() {
    return {
        DOCUMENT_STORE: {
            bindingName: 'DOCUMENT_STORE',
            databaseId: 'database-id',
        },
        KEY_VALUE_STORE: {
            bindingName: 'KEY_VALUE_STORE',
            namespaceId: 'kv-namespace-id',
        },
        CONTENT_STORE: {
            kvBindingName: 'CONTENT_STORE_KV',
            kvNamespaceId: 'content-kv-namespace-id',
            durableObjectBindingName: 'CONTENT_STORE_DO',
            durableObjectClassName: 'ContentAddressableIndexStore',
        },
        OBJECT_STORE: {
            buckets: { assets: { bindingName: 'ASSET_BUCKET', bucketName: 'assets' } },
        },
        ENVARS: {
            APP_NAME: 'kixx-test-app',
            LOG_LEVEL: 'info',
        },
    };
}

function groupByType(bindings) {
    const groups = {};

    for (const binding of bindings) {
        groups[binding.type] = groups[binding.type] ?? [];
        groups[binding.type].push(binding);
    }

    return groups;
}

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}
