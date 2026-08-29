import UsageError from '../usage-error.js';

/**
 * Ensures every KV namespace and D1 database an environment's configuration
 * requires exists before anything else in the create-worker-version pipeline
 * runs. A configured id that does not exist fails naming the config key; a
 * null id is created. Every resource in the environment is processed in one
 * pass, so a developer with several unprovisioned resources gets every id in
 * one message rather than one per run.
 * @module provision-resources
 */

const RESOURCE_SPECS = [
    { configKey: 'DOCUMENT_STORE', kind: 'd1', nameField: 'databaseName', idField: 'databaseId' },
    { configKey: 'KEY_VALUE_STORE', kind: 'kv', nameField: 'namespaceName', idField: 'namespaceId' },
    { configKey: 'CONTENT_STORE', kind: 'kv', nameField: 'kvNamespaceName', idField: 'kvNamespaceId' },
];

/**
 * @typedef {Object} CreatedResource
 * @property {string} configKeyPath - Dotted config key the created id belongs at, such as `DOCUMENT_STORE.databaseId`.
 * @property {string} kind - `d1` or `kv`.
 * @property {string} name - Name the resource was created with.
 * @property {string} id - Cloudflare-assigned identifier.
 */

/**
 * @param {Object} args - Options.
 * @param {Object} args.environmentConfig - One environment's block from `cloudflare-config.js`.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - Cloudflare API client.
 * @returns {Promise<{ created: CreatedResource[] }>} Resources created during this call. Empty when everything already existed.
 * @throws {UsageError} When a configured id does not exist (a 404 from verification).
 * @throws {import('./cloudflare-api-error.js').default} When verification fails for any other reason (propagated unchanged).
 */
export async function resolveResources(args) {
    const { environmentConfig, apiClient } = args ?? {};

    const created = [];

    for (const spec of RESOURCE_SPECS) {
        const block = environmentConfig[spec.configKey];

        if (!block) {
            continue;
        }

        const name = requireField(block[spec.nameField], `${ spec.configKey }.${ spec.nameField }`);
        const id = block[spec.idField];
        const idPath = `${ spec.configKey }.${ spec.idField }`;

        if (id === null || id === undefined) {
            const resource = await createResource(apiClient, spec.kind, name);
            created.push({ configKeyPath: idPath, kind: spec.kind, name, id: resource.id });
        } else {
            await verifyResource(apiClient, spec.kind, id, idPath);
        }
    }

    return { created };
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

async function createResource(apiClient, kind, name) {
    if (kind === 'd1') {
        const database = await apiClient.createD1Database({ name });
        return { id: database.uuid };
    }

    const namespace = await apiClient.createKVNamespace({ title: name });
    return { id: namespace.id };
}

function requireField(value, path) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new UsageError(`${ path } is required and must be a non-empty string`);
    }

    return value;
}
