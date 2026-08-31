import { isString } from 'kixx-assert';
import UsageError from '../usage-error.js';

/**
 * Assembles one environment's configuration blocks and its two parsed dotenv
 * files into a validated, deterministically ordered array of Cloudflare
 * binding definitions. Every way of getting bindings wrong is caught here,
 * naming the config path or the dotenv key at fault.
 *
 * A value's binding type follows the file it was written in and nothing else:
 * `.env.<environment>` is committed, so its values bind as `plain_text`, and
 * `.env.<environment>.secrets` is not, so its values bind as `secret_text`.
 * There is no per-key annotation to keep in sync, and the collision check
 * below is what makes that a true statement rather than a convention — a key
 * written in both files is rejected instead of resolved by precedence.
 *
 * The returned array never contains `BUILD_ID`. It is the bindings hash
 * input, and `BUILD_ID` is generated only after the change decision is made
 * — a caller that added it here would silently destroy idempotency.
 *
 * Config paths named in error messages are relative to the environment block,
 * such as `DOCUMENT_STORE.bindingName`. The orchestrator that calls it can
 * prefix the environment if it chooses.
 * @module worker-bindings
 */

/**
 * @param {Object} args - Options.
 * @param {Object} args.environmentConfig - One environment's block from `cloudflare-config.js`.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {Object<string, string>} args.envars - Parsed `.env.<environment>` values.
 * @param {Object<string, string>} args.secrets - Parsed `.env.<environment>.secrets` values.
 * @returns {Array<Object>} Binding definitions accepted by `CloudflareWorkerVersion#addBinding()`, sorted by name.
 * @throws {UsageError} When a present config block is malformed, a resource id is null,
 *     either dotenv file declares `BUILD_ID`, or a binding name collides across
 *     two sources.
 */
export function buildWorkerBindings(args) {
    const { environmentConfig, environment, envars, secrets } = args ?? {};

    const entries = [
        ...documentStoreBindings(environmentConfig),
        ...keyValueStoreBindings(environmentConfig),
        ...contentStoreBindings(environmentConfig),
        ...objectStoreBindings(environmentConfig),
        ...environmentBinding(environment),
        ...envarsBindings(environment, envars ?? {}),
        ...secretsBindings(environment, secrets ?? {}),
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

// The Worker selects its config section with ENVIRONMENT, which makes it the
// one value that cannot be trusted to the dotenv file that carries it for the
// Node.js server: a .env.staging copied from .env.production would silently
// deploy a Worker running production's config. The value comes from
// --environment, and this is included in the bindings hash rather than
// injected alongside BUILD_ID because it is constant for an environment.
function environmentBinding(environment) {
    return [ {
        source: '--environment',
        binding: { type: 'plain_text', name: 'ENVIRONMENT', text: environment },
    } ];
}

function envarsBindings(environment, envars) {
    const source = `.env.${ environment }`;

    assertNoBuildId(envars, source);

    // ENVIRONMENT belongs in this file for the Node.js server's sake, so its
    // presence is normal rather than an error. Dropping it leaves the injected
    // binding above as the only definition; a stale copy cannot collide with it.
    return Object.keys(envars)
        .filter((name) => name !== 'ENVIRONMENT')
        .map((name) => ({
            source,
            binding: { type: 'plain_text', name, text: envars[name] },
        }));
}

function secretsBindings(environment, secrets) {
    const source = `.env.${ environment }.secrets`;

    assertNoBuildId(secrets, source);

    return Object.keys(secrets).map((name) => ({
        source,
        binding: { type: 'secret_text', name, text: secrets[name] },
    }));
}

function assertNoBuildId(values, source) {
    if (Object.hasOwn(values, 'BUILD_ID')) {
        throw new UsageError(`${ source } may not declare "BUILD_ID"; the command owns that name`);
    }
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
