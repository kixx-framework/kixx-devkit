import { isNonEmptyString } from 'kixx-assert';
import UsageError from '../usage-error.js';
import { readObjectStoreBuckets } from './object-store-buckets.js';

/**
 * Ensures every KV namespace, D1 database, and R2 bucket an environment's
 * configuration requires exists before anything else in the
 * create-worker-version pipeline runs. A configured id that does not exist
 * fails naming the config key; a null id is resolved by name, adopting the
 * account's existing resource when there is one and creating it otherwise.
 * Every resource in the environment is processed in one pass, so a developer
 * with several unrecorded resources gets every id in one message rather than
 * one per run.
 *
 * R2 buckets are addressed by name and jurisdiction, with no Cloudflare id to
 * record, so a missing bucket is created and the pipeline carries on.
 * @module provision-resources
 */

const RESOURCE_SPECS = [
    { configKey: 'DOCUMENT_STORE', kind: 'd1', nameField: 'databaseName', idField: 'databaseId' },
    { configKey: 'KEY_VALUE_STORE', kind: 'kv', nameField: 'namespaceName', idField: 'namespaceId' },
    { configKey: 'CONTENT_STORE', kind: 'kv', nameField: 'kvNamespaceName', idField: 'kvNamespaceId' },
];

const RESOURCE_LABELS = {
    d1: 'D1 database',
    kv: 'KV namespace',
};

// Cloudflare rejects a duplicate D1 database name with this code. The KV
// namespace equivalent is undocumented, so the message is matched as well.
const D1_DUPLICATE_NAME_CODE = 7502;

/**
 * @typedef {Object} ResolvedResource
 * @property {string} configKeyPath - Dotted config key the resolved id belongs at, such as `DOCUMENT_STORE.databaseId`.
 * @property {string} kind - `d1` or `kv`.
 * @property {string} name - Name the resource was resolved by.
 * @property {string} id - Cloudflare-assigned identifier.
 * @property {boolean} created - True when this call created the resource, false when it already existed.
 */

/**
 * @typedef {Object} CreatedBucket
 * @property {string} configPath - Config path of the bucket entry, such as `OBJECT_STORE.buckets.files`.
 * @property {string} name - R2 bucket name.
 * @property {string|undefined} jurisdiction - Jurisdiction it was created in, or undefined for the default.
 */

/**
 * @param {Object} args - Options.
 * @param {Object} args.environmentConfig - One environment's block from `cloudflare-config.js`.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - Cloudflare API client.
 * @returns {Promise<{ resolved: ResolvedResource[], createdBuckets: CreatedBucket[] }>} `resolved` lists
 *     resources whose id is missing from the configuration, each with the id to record there; empty when
 *     every id was already configured. `createdBuckets` lists R2 buckets this call created.
 * @throws {UsageError} When a configured id does not exist (a 404 from verification), when
 *     Cloudflare refuses to create a resource because its name is already taken, or when an
 *     `OBJECT_STORE` bucket entry is malformed.
 * @throws {import('./cloudflare-api-error.js').default} When verification fails for any other reason (propagated unchanged).
 */
export async function resolveResources(args) {
    const { environmentConfig, apiClient } = args ?? {};

    // Read before any remote call so a malformed bucket entry fails without
    // having created a D1 database or KV namespace first.
    const buckets = readObjectStoreBuckets(environmentConfig);

    const resolved = [];

    for (const spec of RESOURCE_SPECS) {
        const block = environmentConfig[spec.configKey];

        if (!block) {
            continue;
        }

        const name = requireField(block[spec.nameField], `${ spec.configKey }.${ spec.nameField }`);
        const id = block[spec.idField];
        const idPath = `${ spec.configKey }.${ spec.idField }`;

        if (id === null || id === undefined) {
            const resource = await resolveByName(apiClient, spec.kind, name, idPath);
            resolved.push({ configKeyPath: idPath, kind: spec.kind, name, id: resource.id, created: resource.created });
        } else {
            await verifyResource(apiClient, spec.kind, id, idPath);
        }
    }

    const createdBuckets = [];

    for (const bucket of buckets) {
        if (await ensureBucket(apiClient, bucket)) {
            createdBuckets.push({
                configPath: bucket.configPath,
                name: bucket.bucketName,
                jurisdiction: bucket.jurisdiction,
            });
        }
    }

    return { resolved, createdBuckets };
}

// An existing bucket is adopted by name and jurisdiction without comparing
// its location hint or storage class. Those are creation-time preferences;
// jurisdiction is part of the bucket's address, so it cannot be ignored.
async function ensureBucket(apiClient, bucket) {
    const { bucketName, jurisdiction, locationHint, storageClass } = bucket;

    try {
        await apiClient.getR2Bucket(bucketName, { jurisdiction });
        return false;
    } catch (error) {
        if (error.status !== 404) {
            throw error;
        }
    }

    try {
        await apiClient.createR2Bucket({ name: bucketName, jurisdiction, locationHint, storageClass });
        return true;
    } catch (error) {
        // A conflict after a 404 lookup means another run created it in
        // between. The binding only needs the bucket to exist, so adopt it.
        if (error.status === 409) {
            return false;
        }

        throw error;
    }
}

async function verifyResource(apiClient, kind, id, idPath) {
    try {
        if (kind === 'd1') {
            await apiClient.getD1Database(id);
        } else {
            await apiClient.getKVNamespace(id);
        }
    } catch (error) {
        if (error.status === 404) {
            throw new UsageError(`${ idPath } "${ id }" does not exist in Cloudflare`, { cause: error });
        }

        throw error;
    }
}

// Reconciling by name before creating keeps this idempotent. Nothing writes
// the created id back into cloudflare-config.js, so a run that reports ids the
// developer has not pasted in yet is repeatable, and a run interrupted between
// two creates does not strand the resources it already made.
async function resolveByName(apiClient, kind, name, idPath) {
    const existingId = await findResourceIdByName(apiClient, kind, name);

    if (existingId) {
        return { id: existingId, created: false };
    }

    try {
        const id = await createResource(apiClient, kind, name);

        return { id, created: true };
    } catch (error) {
        if (isNameConflictError(error)) {
            throw new UsageError(
                `Cannot create ${ RESOURCE_LABELS[kind] } "${ name }" for ${ idPath }: Cloudflare reports the ` +
                'name is taken, but no resource with that name was in the account listing. Copy the id from ' +
                `the Cloudflare dashboard into ${ idPath }.`,
                { cause: error },
            );
        }

        throw error;
    }
}

async function findResourceIdByName(apiClient, kind, name) {
    if (kind === 'd1') {
        const database = await apiClient.findD1DatabaseByName(name);
        return database ? database.uuid : null;
    }

    const namespace = await apiClient.findKVNamespaceByName(name);
    return namespace ? namespace.id : null;
}

async function createResource(apiClient, kind, name) {
    if (kind === 'd1') {
        const database = await apiClient.createD1Database({ name });
        return database.uuid;
    }

    const namespace = await apiClient.createKVNamespace({ title: name });
    return namespace.id;
}

// A name conflict surviving the lookup above means the name is visible to the
// create endpoint but not to the list endpoint: a concurrent run, or a
// resource the API token cannot list.
function isNameConflictError(error) {
    return Array.isArray(error?.errors) && error.errors.some((entry) => {
        return entry.code === D1_DUPLICATE_NAME_CODE || /already exists/i.test(entry.message ?? '');
    });
}

function requireField(value, path) {
    if (!isNonEmptyString(value)) {
        throw new UsageError(`${ path } is required and must be a non-empty string`);
    }

    return value;
}
