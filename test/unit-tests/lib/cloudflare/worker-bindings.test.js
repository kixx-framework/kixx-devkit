import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { buildWorkerBindings } from '../../../../lib/cloudflare/worker-bindings.js';
import CloudflareWorkerVersion from '../../../../lib/cloudflare/cloudflare-worker-version.js';


describe('worker-bindings', ({ it }) => {
    it('produces the expected binding set from a full sample environment', () => {
        const bindings = build({ secrets: { API_SECRET: 'shh' } });

        const byType = groupByType(bindings);

        assertEqual(1, byType.d1.length);
        assertEqual(2, byType.kv_namespace.length);
        assertEqual(1, byType.durable_object_namespace.length);
        assertEqual(1, byType.r2_bucket.length);
        // TRUST_PROXY, plus the injected ENVIRONMENT.
        assertEqual(2, byType.plain_text.length);
        assertEqual(1, byType.secret_text.length);
    });

    it('binds the plain file as plain_text and the secrets file as secret_text', () => {
        const bindings = build({
            envars: { TRUST_PROXY: 'false' },
            secrets: { API_SECRET: 'shh' },
        });

        const byName = groupByName(bindings);

        assertEqual('plain_text', byName.TRUST_PROXY.type);
        assertEqual('false', byName.TRUST_PROXY.text);
        assertEqual('secret_text', byName.API_SECRET.type);
        assertEqual('shh', byName.API_SECRET.text);
    });

    it('binds ENVIRONMENT from the environment name, ignoring the value in the plain file', () => {
        const bindings = build({ envars: { ENVIRONMENT: 'development' } });

        const environmentBindings = bindings.filter((binding) => binding.name === 'ENVIRONMENT');

        assertEqual(1, environmentBindings.length);
        assertEqual('plain_text', environmentBindings[0].type);
        assertEqual('production', environmentBindings[0].text);
    });

    it('binds ENVIRONMENT even when the plain file omits it', () => {
        const bindings = build({ environmentConfig: {}, envars: {} });

        assertEqual(1, bindings.length);
        assertEqual('ENVIRONMENT', bindings[0].name);
        assertEqual('production', bindings[0].text);
    });

    it('never includes BUILD_ID even with unrelated envars and secrets', () => {
        const bindings = build({ secrets: { API_SECRET: 'shh' } });

        assert(!bindings.some((binding) => binding.name === 'BUILD_ID'), 'expected no BUILD_ID binding');
    });

    it('produces no r2_bucket bindings for an empty buckets array', () => {
        const config = makeEnvironmentConfig();
        config.OBJECT_STORE = { buckets: {} };

        const bindings = build({ environmentConfig: config });

        assert(!bindings.some((binding) => binding.type === 'r2_bucket'), 'expected no r2_bucket bindings');
    });

    it('omits every config block independently', () => {
        const bindings = build({ environmentConfig: {}, envars: {}, secrets: {} });

        assertEqual(1, bindings.length);
        assertEqual('ENVIRONMENT', bindings[0].name);
    });

    it('throws a UsageError naming the config path for a missing required field', () => {
        const config = makeEnvironmentConfig();
        delete config.DOCUMENT_STORE.bindingName;

        const caught = catchError(() => build({ environmentConfig: config }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE.bindingName'), 'expected the message to name the path');
    });

    it('throws when a resource id is null', () => {
        const config = makeEnvironmentConfig();
        config.DOCUMENT_STORE.databaseId = null;

        const caught = catchError(() => build({ environmentConfig: config }));

        assert(caught, 'expected an error to be thrown');
    });

    it('throws naming the plain file when it declares BUILD_ID', () => {
        const caught = catchError(() => build({ envars: { BUILD_ID: 'nope' } }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('.env.production'), 'expected the message to name the file');
    });

    it('throws naming the secrets file when it declares BUILD_ID', () => {
        const caught = catchError(() => build({ secrets: { BUILD_ID: 'nope' } }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('.env.production.secrets'), 'expected the message to name the file');
    });

    it('throws naming both files for a name written in both of them', () => {
        const caught = catchError(() => {
            return build({ envars: { API_SECRET: 'plain' }, secrets: { API_SECRET: 'secret' } });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('.env.production'), 'expected the message to name the plain file');
        assert(caught.message.includes('.env.production.secrets'), 'expected the message to name the secrets file');
    });

    it('throws naming both sources for a dotenv name colliding with a config binding name', () => {
        const caught = catchError(() => build({ secrets: { DOCUMENT_STORE: 'collides' } }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE'), 'expected the message to name DOCUMENT_STORE');
    });

    it('throws naming both sources for a duplicate name across two config blocks', () => {
        const config = makeEnvironmentConfig();
        config.KEY_VALUE_STORE.bindingName = config.DOCUMENT_STORE.bindingName;

        const caught = catchError(() => build({ environmentConfig: config }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('DOCUMENT_STORE'), 'expected the message to name DOCUMENT_STORE');
        assert(caught.message.includes('KEY_VALUE_STORE'), 'expected the message to name KEY_VALUE_STORE');
    });

    it('sorts the result by name regardless of input key order', () => {
        const config = makeEnvironmentConfig();

        const bindingsOne = build({ environmentConfig: config, secrets: { API_SECRET: 'shh' } });

        const reordered = {
            OBJECT_STORE: config.OBJECT_STORE,
            CONTENT_STORE: config.CONTENT_STORE,
            KEY_VALUE_STORE: config.KEY_VALUE_STORE,
            DOCUMENT_STORE: config.DOCUMENT_STORE,
        };
        const bindingsTwo = build({ environmentConfig: reordered, secrets: { API_SECRET: 'shh' } });

        assertEqual(JSON.stringify(bindingsOne), JSON.stringify(bindingsTwo));

        const names = bindingsOne.map((binding) => binding.name);
        const sortedNames = names.slice().sort();
        assertEqual(sortedNames.join(','), names.join(','));
    });

    it('produces a secret_text binding with an empty text for an empty-string secret', () => {
        const bindings = build({ environmentConfig: {}, secrets: { EMPTY_SECRET: '' } });

        const byName = groupByName(bindings);

        assertEqual('secret_text', byName.EMPTY_SECRET.type);
        assertEqual('', byName.EMPTY_SECRET.text);
    });

    it('produces bindings every one of which CloudflareWorkerVersion#addBinding() accepts', () => {
        const bindings = build({ secrets: { API_SECRET: 'shh' } });

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
    };
}

// Every case here is a variation on one full environment, so the defaults are
// the sample and a test names only what it is actually varying.
function build(args) {
    const {
        environmentConfig = makeEnvironmentConfig(),
        environment = 'production',
        envars = { TRUST_PROXY: 'false' },
        secrets = {},
    } = args;

    return buildWorkerBindings({ environmentConfig, environment, envars, secrets });
}

function groupByName(bindings) {
    const byName = {};

    for (const binding of bindings) {
        byName[binding.name] = binding;
    }

    return byName;
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
