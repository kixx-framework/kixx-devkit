import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { createWorkerVersion } from '../../../../lib/cloudflare/create-worker-version.js';
import CloudflareApiError from '../../../../lib/cloudflare/cloudflare-api-error.js';

const FIXED_DATE = new Date('2026-08-29T16:49:32.000Z');
const PROJECT_DIRECTORY = '/app';
const ENVIRONMENT = 'production';
const STATE_FILEPATH = '/app/.kixx/cloudflare-state.production.json';
const ENV_FILEPATH = '/app/.env.production';

describe('create-worker-version', ({ it }) => {
    it('throws a UsageError naming the dotted path for a missing environment block', async () => {
        const caught = await catchAsyncError(() => {
            return createWorkerVersion(runOptions({ cloudflareConfig: { environments: {} } }));
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('environments.production'), 'expected the message to name the path');
    });

    it('throws a UsageError naming the create-worker invocation for a 404 Worker', async () => {
        const apiClient = makeApiClient({
            getWorker: async () => {
                throw new CloudflareApiError('not found', { status: 404, method: 'GET', url: 'x' });
            },
        });

        const caught = await catchAsyncError(() => createWorkerVersion(runOptions({ apiClient })));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('create-worker'), 'expected the message to name the create-worker command');
        assertEqual(0, apiClient.calls.getKVNamespace.length);
    });

    it('returns resources-created and never bundles, uploads, or writes state', async () => {
        const config = makeCloudflareConfig();
        config.environments.production.DOCUMENT_STORE.databaseId = null;

        const bundleModules = makeBundler('export default 1;');
        const fileSystem = makeFileSystem({});
        const apiClient = makeApiClient({
            createD1Database: async () => ({ uuid: 'new-database-id' }),
        });

        const result = await createWorkerVersion(runOptions({
            cloudflareConfig: config,
            apiClient,
            bundleModules,
            fileSystem,
        }));

        assertEqual('resources-created', result.outcome);
        assertEqual(1, result.createdResources.length);
        assertEqual(0, bundleModules.callCount);
        assertEqual(0, apiClient.calls.createWorkerVersion.length);
        assert(!Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH), 'expected no state file written');
    });

    it('uploads on a first run with no state file, with changes all true', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        assertEqual('created', result.outcome);
        assertEqual(true, result.changes.modules);
        assertEqual(true, result.changes.bindings);
        assertEqual(true, result.changes.config);
        assert(Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH), 'expected state to be written');
    });

    it('skips a second run with unchanged inputs, making no createWorkerVersion call', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const writesAfterFirstRun = apiClient.calls.createWorkerVersion.length;
        const stateTextAfterFirstRun = fileSystem.written[STATE_FILEPATH];

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        assertEqual('skipped', result.outcome);
        assertEqual(writesAfterFirstRun, apiClient.calls.createWorkerVersion.length);
        assertEqual(stateTextAfterFirstRun, fileSystem.written[STATE_FILEPATH]);
    });

    it('uploads with only changes.modules true when the module source changes', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const bundleModules = makeBundler('export default 2;');
        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, bundleModules }));

        assertEqual('created', result.outcome);
        assertEqual(true, result.changes.modules);
        assertEqual(false, result.changes.bindings);
        assertEqual(false, result.changes.config);
    });

    it('uploads with only changes.bindings true when a secret value changes', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        fileSystem.files[ENV_FILEPATH] = 'API_SECRET=different\n';
        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        assertEqual('created', result.outcome);
        assertEqual(false, result.changes.modules);
        assertEqual(true, result.changes.bindings);
        assertEqual(false, result.changes.config);
    });

    it('uploads with only changes.config true when compatibility_date changes', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });
        const configOne = makeCloudflareConfig();

        await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig: configOne }));

        const configTwo = makeCloudflareConfig();
        configTwo.environments.production.WORKER_VERSION.compatibility_date = '2026-08-01';

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig: configTwo }));

        assertEqual('created', result.outcome);
        assertEqual(false, result.changes.modules);
        assertEqual(false, result.changes.bindings);
        assertEqual(true, result.changes.config);
    });

    it('uploads a pending Durable Object migration even when all three hashes match', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        // Simulate the Worker's recorded class list falling behind config
        // (for instance a hand-edited state file) with every hash left
        // untouched, so only the migration should force the next upload.
        const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);
        state.durableObjectClasses = [];
        fileSystem.files[STATE_FILEPATH] = `${ JSON.stringify(state, null, 4) }\n`;
        delete fileSystem.written[STATE_FILEPATH];

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        assertEqual('created', result.outcome);
        assertEqual(false, result.changes.modules);
        assertEqual(false, result.changes.bindings);
        assertEqual(false, result.changes.config);
        assert(result.migrations, 'expected a migration to be recorded');
    });

    it('uploads when nothing changed and --force is set', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const before = apiClient.calls.createWorkerVersion.length;
        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, force: true }));

        assertEqual('created', result.outcome);
        assertEqual(before + 1, apiClient.calls.createWorkerVersion.length);
    });

    it('includes BUILD_ID as a plain_text binding and excludes it from the bindings hash', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;
        const buildIdBinding = payload.bindings.find((binding) => binding.name === 'BUILD_ID');

        assert(buildIdBinding, 'expected a BUILD_ID binding');
        assertEqual('plain_text', buildIdBinding.type);
    });

    it('produces the same three hashes across two independent runs whose only difference is the clock', async () => {
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const fileSystemOne = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        await createWorkerVersion(runOptions({
            apiClient,
            fileSystem: fileSystemOne,
            now: () => new Date('2026-01-01T00:00:00.000Z'),
        }));
        const stateOne = JSON.parse(fileSystemOne.written[STATE_FILEPATH]);

        const fileSystemTwo = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        await createWorkerVersion(runOptions({
            apiClient,
            fileSystem: fileSystemTwo,
            now: () => new Date('2027-01-01T00:00:00.000Z'),
        }));
        const stateTwo = JSON.parse(fileSystemTwo.written[STATE_FILEPATH]);

        assertEqual(stateOne.modulesHash, stateTwo.modulesHash);
        assertEqual(stateOne.bindingsHash, stateTwo.bindingsHash);
        assertEqual(stateOne.configHash, stateTwo.configHash);
        assert(stateOne.buildId !== stateTwo.buildId, 'expected the buildId itself to differ, since the clock did');
    });

    it('carries workers/tag and workers/triggered_by annotations with no workers/message', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;

        assertEqual(result.buildId, payload.annotations['workers/tag']);
        assertEqual('kixx.js cloudflare create-worker-version', payload.annotations['workers/triggered_by']);
        assert(!Object.prototype.hasOwnProperty.call(payload.annotations, 'workers/message'), 'expected no workers/message');
    });

    it('uploads main_module as cloudflare-server.js with no ./ prefix on any module name', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;

        assertEqual('cloudflare-server.js', payload.main_module);
        assert(payload.modules.every((mod) => !mod.name.startsWith('./')), 'expected no ./-prefixed module name');
    });

    it('omits migrations and leaves migrationTag unchanged when no migration applies', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });
        const config = makeCloudflareConfig();
        delete config.environments.production.CONTENT_STORE;

        await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig: config }));

        const payload = apiClient.calls.createWorkerVersion[0].version;
        const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);

        assert(!Object.prototype.hasOwnProperty.call(payload, 'migrations'), 'expected no migrations key');
        assertEqual(null, state.migrationTag);
    });

    it('sends old_tag and new_tag and records the new tag when a migration applies', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;
        const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);

        assertEqual(undefined, payload.migrations.old_tag);
        assertEqual('v1', payload.migrations.new_tag);
        assertEqual('v1', state.migrationTag);
        assertEqual('v1', result.migrations.newTag);
    });

    it('forwards deploy: true to createWorkerVersion() and records it in the state', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, deploy: true }));

        const call = apiClient.calls.createWorkerVersion[0];
        const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);

        assertEqual(true, call.options.deploy);
        assertEqual(true, state.deployed);
        assertEqual(true, result.deployed);
    });

    it('writes no state file when createWorkerVersion() fails', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            createWorkerVersion: async () => {
                throw new CloudflareApiError('server error', { status: 500, method: 'POST', url: 'x' });
            },
        });

        const caught = await catchAsyncError(() => createWorkerVersion(runOptions({ apiClient, fileSystem })));

        assert(caught, 'expected an error to be thrown');
        assert(!Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH), 'expected no state file written');
    });

    it('rethrows a migration-tag rejection as a UsageError naming the tag to record', async () => {
        const fileSystem = makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            createWorkerVersion: async () => {
                throw new CloudflareApiError('rejected', {
                    status: 409,
                    errors: [ { code: 10061, message: 'migration tag mismatch' } ],
                    method: 'POST',
                    url: 'x',
                });
            },
        });

        const caught = await catchAsyncError(() => createWorkerVersion(runOptions({ apiClient, fileSystem })));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('v1'), 'expected the message to name the tag to record');
    });
});

function runOptions(overrides) {
    return {
        projectDirectory: PROJECT_DIRECTORY,
        environment: ENVIRONMENT,
        cloudflareConfig: makeCloudflareConfig(),
        apiClient: makeApiClient({}),
        bundleModules: makeBundler('export default 1;'),
        fileSystem: makeFileSystem({ [ENV_FILEPATH]: 'API_SECRET=shh\n' }),
        now: () => FIXED_DATE,
        ...overrides,
    };
}

function makeCloudflareConfig() {
    return {
        name: 'kixx-test-app',
        environments: {
            production: {
                WORKER: { name: 'kixx-test-app' },
                WORKER_VERSION: {
                    compatibility_date: '2026-07-10',
                },
                DOCUMENT_STORE: {
                    bindingName: 'DOCUMENT_STORE',
                    databaseName: 'kixx-test-document-store',
                    databaseId: 'database-id',
                },
                KEY_VALUE_STORE: {
                    bindingName: 'KEY_VALUE_STORE',
                    namespaceName: 'kixx-test-kv-store',
                    namespaceId: 'namespace-id',
                },
                CONTENT_STORE: {
                    kvBindingName: 'CONTENT_STORE_KV',
                    kvNamespaceName: 'kixx-test-content-store',
                    kvNamespaceId: 'content-namespace-id',
                    durableObjectBindingName: 'CONTENT_STORE_DO',
                    durableObjectClassName: 'ContentAddressableIndexStore',
                },
                ENVARS: {
                    APP_NAME: 'kixx-test-app',
                },
            },
        },
    };
}

function makeBundler(source) {
    const bundler = async () => {
        bundler.callCount += 1;
        const modules = new Map();
        modules.set('./cloudflare-server.js', { name: './cloudflare-server.js', source });
        return { entry: './cloudflare-server.js', modules };
    };

    bundler.callCount = 0;

    return bundler;
}

function makeFileSystem(files) {
    const written = {};

    return {
        files,
        written,
        async isFile(filepath) {
            return Object.prototype.hasOwnProperty.call(files, filepath) ||
                Object.prototype.hasOwnProperty.call(written, filepath);
        },
        async readFile(filepath) {
            if (Object.prototype.hasOwnProperty.call(written, filepath)) {
                return written[filepath];
            }
            if (!Object.prototype.hasOwnProperty.call(files, filepath)) {
                throw new Error(`ENOENT: no such file, open '${ filepath }'`);
            }
            return files[filepath];
        },
        async writeFile(filepath, contents) {
            written[filepath] = contents;
        },
    };
}

function makeApiClient(implementations) {
    const calls = {
        getWorker: [],
        getKVNamespace: [],
        getD1Database: [],
        createKVNamespace: [],
        createD1Database: [],
        createWorkerVersion: [],
    };

    return {
        calls,
        async getWorker(name) {
            calls.getWorker.push(name);
            return implementations.getWorker ? implementations.getWorker(name) : { id: 'worker-id', name };
        },
        async getKVNamespace(id) {
            calls.getKVNamespace.push(id);
            return implementations.getKVNamespace ? implementations.getKVNamespace(id) : { id };
        },
        async getD1Database(id) {
            calls.getD1Database.push(id);
            return implementations.getD1Database ? implementations.getD1Database(id) : { uuid: id };
        },
        async createKVNamespace(payload) {
            calls.createKVNamespace.push(payload);
            return implementations.createKVNamespace
                ? implementations.createKVNamespace(payload)
                : { id: 'created-namespace-id' };
        },
        async createD1Database(payload) {
            calls.createD1Database.push(payload);
            return implementations.createD1Database
                ? implementations.createD1Database(payload)
                : { uuid: 'created-database-id' };
        },
        async createWorkerVersion(workerName, version, options) {
            calls.createWorkerVersion.push({ workerName, version, options });
            return implementations.createWorkerVersion
                ? implementations.createWorkerVersion(workerName, version, options)
                : { id: 'version-id' };
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
