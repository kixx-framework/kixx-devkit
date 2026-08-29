import { isString } from 'kixx-assert';
import UsageError from '../usage-error.js';

/**
 * Assembles one environment's configuration blocks and its parsed `.env`
 * secrets into a validated, deterministically ordered array of Cloudflare
 * binding definitions. Every way of getting bindings wrong is caught here,
 * naming the config path or the `.env` key at fault.
 *
 * The returned array never contains `BUILD_ID`. It is the bindings hash
 * input, and `BUILD_ID` is generated only after the change decision is made
 * — a caller that added it here would silently destroy idempotency.
 *
 * Config paths named in error messages are relative to the environment
 * block, such as `DOCUMENT_STORE.bindingName`, because this function is not
 * given the environment name. The orchestrator that calls it knows the
 * environment and can prefix the path if it chooses.
 * @module worker-bindings
 */

/**
 * @param {Object} args - Options.
 * @param {Object} args.environmentConfig - One environment's block from `cloudflare-config.js`.
 * @param {Object<string, string>} args.secrets - Parsed `.env.<environment>` values.
 * @returns {Array<Object>} Binding definitions accepted by `CloudflareWorkerVersion#addBinding()`, sorted by name.
 * @throws {UsageError} When a present config block is malformed, a resource id is null,
 *     an `ENVARS` value is not a string, `ENVARS` declares `BUILD_ID`, or a binding
 *     name collides across two sources.
 */
export function buildWorkerBindings(args) {
    const { environmentConfig, secrets } = args ?? {};

    const entries = [
        ...documentStoreBindings(environmentConfig),
        ...keyValueStoreBindings(environmentConfig),
        ...contentStoreBindings(environmentConfig),
        ...objectStoreBindings(environmentConfig),
        ...envarsBindings(environmentConfig),
        ...secretsBindings(secrets ?? {}),
    ];

    checkCollisions(entries);

    return entries
        .map((entry) => entry.binding)
        .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function documentStoreBindings(environmentConfig) {
    const block = environmentConfig.DOCUMENT_STORE;

    if (!block) {
        return [];
    }

    const bindingName = requireField(block.bindingName, 'DOCUMENT_STORE.bindingName');
    const databaseId = requireId(block.databaseId, 'DOCUMENT_STORE.databaseId');

    return [ {
        source: 'DOCUMENT_STORE',
        binding: { type: 'd1', name: bindingName, id: databaseId },
    } ];
}

function keyValueStoreBindings(environmentConfig) {
    const block = environmentConfig.KEY_VALUE_STORE;

    if (!block) {
        return [];
    }

    const bindingName = requireField(block.bindingName, 'KEY_VALUE_STORE.bindingName');
    const namespaceId = requireId(block.namespaceId, 'KEY_VALUE_STORE.namespaceId');

    return [ {
        source: 'KEY_VALUE_STORE',
        binding: { type: 'kv_namespace', name: bindingName, namespace_id: namespaceId },
    } ];
}

function contentStoreBindings(environmentConfig) {
    const block = environmentConfig.CONTENT_STORE;

    if (!block) {
        return [];
    }

    const kvBindingName = requireField(block.kvBindingName, 'CONTENT_STORE.kvBindingName');
    const kvNamespaceId = requireId(block.kvNamespaceId, 'CONTENT_STORE.kvNamespaceId');
    const durableObjectBindingName = requireField(
        block.durableObjectBindingName,
        'CONTENT_STORE.durableObjectBindingName',
    );
    const durableObjectClassName = requireField(
        block.durableObjectClassName,
        'CONTENT_STORE.durableObjectClassName',
    );

    return [
        {
            source: 'CONTENT_STORE',
            binding: { type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId },
        },
        {
            source: 'CONTENT_STORE',
            binding: {
                type: 'durable_object_namespace',
                name: durableObjectBindingName,
                class_name: durableObjectClassName,
            },
        },
    ];
}

function objectStoreBindings(environmentConfig) {
    const block = environmentConfig.OBJECT_STORE;

    if (!block) {
        return [];
    }

    const buckets = block.buckets ?? {};

    return Object.keys(buckets).map((key) => {
        const bucket = buckets[key];
        const path = `OBJECT_STORE.buckets.${ key }`;
        const bindingName = requireField(bucket.bindingName, `${ path }.bindingName`);
        const bucketName = requireField(bucket.bucketName, `${ path }.bucketName`);

        return {
            source: path,
            binding: { type: 'r2_bucket', name: bindingName, bucket_name: bucketName },
        };
    });
}

function envarsBindings(environmentConfig) {
    const block = environmentConfig.ENVARS;

    if (!block) {
        return [];
    }

    if (Object.hasOwn(block, 'BUILD_ID')) {
        throw new UsageError('ENVARS may not declare "BUILD_ID"; the command owns that name');
    }

    return Object.keys(block).map((name) => {
        const value = block[name];

        if (!isString(value)) {
            throw new UsageError(`ENVARS.${ name } must be a string, got ${ typeof value }`);
        }

        return {
            source: 'ENVARS',
            binding: { type: 'plain_text', name, text: value },
        };
    });
}

function secretsBindings(secrets) {
    return Object.keys(secrets).map((name) => ({
        source: '.env',
        binding: { type: 'secret_text', name, text: secrets[name] },
    }));
}

function checkCollisions(entries) {
    const bySourceAndName = new Map();

    for (const entry of entries) {
        const name = entry.binding.name;
        const existing = bySourceAndName.get(name);

        if (existing) {
            throw new UsageError(
                `Duplicate binding name "${ name }" from both ${ existing.source } and ${ entry.source }`,
            );
        }

        bySourceAndName.set(name, entry);
    }
}

// A required field that is missing or empty. Used for binding names and
// Durable Object class names, which are always caller-supplied strings.
function requireField(value, path) {
    if (isString(value) && value.length > 0) {
        return value;
    }

    throw new UsageError(`${ path } is required and must be a non-empty string`);
}

// A required resource id. A null id reaching this function means Task 9's
// resource resolution was skipped or composed incorrectly upstream: this
// function never resolves or creates resources itself.
function requireId(value, path) {
    if (value === null) {
        throw new Error(
            `worker-bindings: ${ path } is null; resource resolution must run before buildWorkerBindings()`,
        );
    }

    return requireField(value, path);
}
