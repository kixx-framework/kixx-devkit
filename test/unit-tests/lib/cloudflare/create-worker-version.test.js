import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { createWorkerVersion } from '../../../../lib/cloudflare/create-worker-version.js';
import CloudflareApiError from '../../../../lib/cloudflare/cloudflare-api-error.js';

const FIXED_DATE = new Date('2026-08-29T16:49:32.000Z');
const PROJECT_DIRECTORY = '/app';
const ENVIRONMENT = 'production';
const STATE_FILEPATH = '/app/.kixx/cloudflare-state.production.json';
const ENVARS_FILEPATH = '/app/.env.production';
const SECRETS_FILEPATH = '/app/.env.production.secrets';

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

    it('returns resources-resolved and never bundles, uploads, or writes state', async () => {
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

        assertEqual('resources-resolved', result.outcome);
        assertEqual(1, result.resolvedResources.length);
        assertEqual(true, result.resolvedResources[0].created);
        assertEqual(0, bundleModules.callCount);
        assertEqual(0, apiClient.calls.createWorkerVersion.length);
        assert(!Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH), 'expected no state file written');
    });

    it('throws a UsageError naming the secrets file when it is missing', async () => {
        const fileSystem = makeFileSystem({});
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const caught = await catchAsyncError(() => createWorkerVersion(runOptions({ apiClient, fileSystem })));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes(SECRETS_FILEPATH), 'expected the message to name the secrets file');
        assertEqual(0, apiClient.calls.createWorkerVersion.length);
    });

    it('uploads the two dotenv files as plain_text and secret_text, plus BUILD_ID and ENVIRONMENT', async () => {
        const fileSystem = makeFileSystem({
            [ENVARS_FILEPATH]: 'ENVIRONMENT=development\nTRUST_PROXY=false\n',
            [SECRETS_FILEPATH]: 'API_SECRET=shh\n',
        });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;
        const byName = {};

        for (const binding of payload.bindings) {
            byName[binding.name] = binding;
        }

        assertEqual('plain_text', byName.TRUST_PROXY.type);
        assertEqual('secret_text', byName.API_SECRET.type);
        assertEqual('plain_text', byName.BUILD_ID.type);
        assertEqual(result.buildId, byName.BUILD_ID.text);

        // --environment wins over the value the file carries for the Node.js server.
        assertEqual('plain_text', byName.ENVIRONMENT.type);
        assertEqual('production', byName.ENVIRONMENT.text);
    });

    it('uploads on a first run with no state file, with changes all true', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        assertEqual('created', result.outcome);
        assertEqual(true, result.changes.modules);
        assertEqual(true, result.changes.bindings);
        assertEqual(true, result.changes.config);
        assert(Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH), 'expected state to be written');
    });

    it('skips a second run with unchanged inputs, making no createWorkerVersion call', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
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
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
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
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        fileSystem.files[SECRETS_FILEPATH] = 'API_SECRET=different\n';
        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        assertEqual('created', result.outcome);
        assertEqual(false, result.changes.modules);
        assertEqual(true, result.changes.bindings);
        assertEqual(false, result.changes.config);
    });

    it('uploads with only changes.config true when compatibility_date changes', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
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

    it('uploads when nothing changed and --force is set', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const before = apiClient.calls.createWorkerVersion.length;
        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, force: true }));

        assertEqual('created', result.outcome);
        assertEqual(before + 1, apiClient.calls.createWorkerVersion.length);
    });

    it('includes BUILD_ID as a plain_text binding and excludes it from the bindings hash', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;
        const buildIdBinding = payload.bindings.find((binding) => binding.name === 'BUILD_ID');

        assert(buildIdBinding, 'expected a BUILD_ID binding');
        assertEqual('plain_text', buildIdBinding.type);
    });

    it('produces the same three hashes across two independent runs whose only difference is the clock', async () => {
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const fileSystemOne = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        await createWorkerVersion(runOptions({
            apiClient,
            fileSystem: fileSystemOne,
            now: () => new Date('2026-01-01T00:00:00.000Z'),
        }));
        const stateOne = JSON.parse(fileSystemOne.written[STATE_FILEPATH]);

        const fileSystemTwo = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
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
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;

        assertEqual(result.buildId, payload.annotations['workers/tag']);
        assertEqual('kixx.js cloudflare create-worker-version', payload.annotations['workers/triggered_by']);
        assert(!Object.prototype.hasOwnProperty.call(payload.annotations, 'workers/message'), 'expected no workers/message');
    });

    it('uploads main_module as cloudflare-server.js with no ./ prefix on any module name', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;

        assertEqual('cloudflare-server.js', payload.main_module);
        assert(payload.modules.every((mod) => !mod.name.startsWith('./')), 'expected no ./-prefixed module name');
    });

    it('omits the exports key when the environment declares no Durable Object', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));

        const payload = apiClient.calls.createWorkerVersion[0].version;
        const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);

        assert(!Object.prototype.hasOwnProperty.call(payload, 'exports'), 'expected no exports key');
        assert(!Object.prototype.hasOwnProperty.call(payload, 'migrations'), 'expected no migrations key');
        assert(!Object.prototype.hasOwnProperty.call(state, 'migrationTag'), 'expected no migrationTag');
        assert(
            !Object.prototype.hasOwnProperty.call(state, 'durableObjectClasses'),
            'expected no durableObjectClasses',
        );
    });

    it('deploys without the flag when introducing a class on a never-deployed Worker', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            getWorker: () => ({ id: 'worker-id', name: 'kixx-test-app', deployed_on: null }),
            createWorkerVersion: async () => ({ id: 'version-id' }),
        });

        const result = await createWorkerVersion(runOptions({
            apiClient,
            fileSystem,
            cloudflareConfig: withContentStore(makeCloudflareConfig()),
        }));

        const call = apiClient.calls.createWorkerVersion[0];

        assertEqual('created', result.outcome);
        assertEqual(true, call.options.deploy);
        assertEqual(true, result.deployed);
        assertEqual('ContentAddressableIndexStore', result.forcedDeploymentClasses.join(','));
        assertEqual('durable-object', call.version.exports.ContentAddressableIndexStore.type);
        assertEqual('sqlite', call.version.exports.ContentAddressableIndexStore.storage);
        assertEqual(true, JSON.parse(fileSystem.written[STATE_FILEPATH]).deployed);
    });

    it('aborts naming --deploy when introducing a class on a deployed Worker', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            getWorker: () => deployedWorker([]),
            createWorkerVersion: async () => ({ id: 'version-id' }),
        });

        const caught = await catchAsyncError(() => {
            return createWorkerVersion(runOptions({
                apiClient,
                fileSystem,
                cloudflareConfig: withContentStore(makeCloudflareConfig()),
            }));
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('CONTENT_STORE_DO'), 'expected the message to name the binding');
        assert(
            caught.message.includes('ContentAddressableIndexStore'),
            'expected the message to name the class',
        );
        assert(caught.message.includes('--deploy'), 'expected the message to name --deploy');
        assertEqual(0, apiClient.calls.createWorkerVersion.length);
        assert(
            !Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH),
            'expected no state file written',
        );
    });

    it('deploys an explicitly requested deployment on a deployed Worker', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            getWorker: () => deployedWorker([]),
            createWorkerVersion: async () => ({ id: 'version-id' }),
        });

        const result = await createWorkerVersion(runOptions({
            apiClient,
            fileSystem,
            deploy: true,
            cloudflareConfig: withContentStore(makeCloudflareConfig()),
        }));

        assertEqual(true, apiClient.calls.createWorkerVersion[0].options.deploy);
        assertEqual(true, result.deployed);
        assertEqual(null, result.forcedDeploymentClasses);
    });

    it('does not treat an already provisioned class as introduced', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            getWorker: () => deployedWorker([ 'ContentAddressableIndexStore' ]),
            createWorkerVersion: async () => ({ id: 'version-id' }),
        });

        const result = await createWorkerVersion(runOptions({
            apiClient,
            fileSystem,
            cloudflareConfig: withContentStore(makeCloudflareConfig()),
        }));

        assertEqual('created', result.outcome);
        assertEqual(false, apiClient.calls.createWorkerVersion[0].options.deploy);
        assertEqual(false, result.deployed);
        assertEqual(null, result.forcedDeploymentClasses);
    });

    it('uploads again when the hashes match but the namespace is still missing', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });
        const cloudflareConfig = withContentStore(makeCloudflareConfig());

        await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig }));
        carryStateForward(fileSystem);

        // Cloudflare still reports no namespace, so the class was never
        // provisioned and skipping would strand it forever.
        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig }));

        assertEqual('created', result.outcome);
        assertEqual(false, result.changes.modules);
        assertEqual(false, result.changes.bindings);
        assertEqual(false, result.changes.config);
        assertEqual(2, apiClient.calls.createWorkerVersion.length);
    });

    it('skips once the namespace exists and nothing else changed', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const cloudflareConfig = withContentStore(makeCloudflareConfig());
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig }));
        carryStateForward(fileSystem);

        const provisioned = makeApiClient({
            getWorker: () => deployedWorker([ 'ContentAddressableIndexStore' ]),
            createWorkerVersion: async () => ({ id: 'version-id' }),
        });

        const result = await createWorkerVersion(runOptions({
            apiClient: provisioned,
            fileSystem,
            cloudflareConfig,
        }));

        assertEqual('skipped', result.outcome);
        assertEqual(0, provisioned.calls.createWorkerVersion.length);
    });

    it('uploads on a tombstone-only configuration edit', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));
        carryStateForward(fileSystem);

        const cloudflareConfig = makeCloudflareConfig();
        cloudflareConfig.environments.production.DURABLE_OBJECT_MIGRATIONS = [
            { action: 'delete', className: 'LegacyStore' },
        ];

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig }));
        const payload = apiClient.calls.createWorkerVersion[1].version;

        assertEqual('created', result.outcome);
        assertEqual(true, result.changes.bindings);
        assertEqual('deleted', payload.exports.LegacyStore.state);
    });

    it('reports the reconciliation Cloudflare returned, and null when it returned none', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const reconciliation = { created: [ 'ContentAddressableIndexStore' ], removable_entries: [] };
        const apiClient = makeApiClient({
            createWorkerVersion: async () => ({ id: 'version-id', exports_reconciliation: reconciliation }),
        });

        const withReport = await createWorkerVersion(runOptions({
            apiClient,
            fileSystem,
            cloudflareConfig: withContentStore(makeCloudflareConfig()),
        }));

        assertEqual(reconciliation, withReport.reconciliation);

        const bare = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });
        const withoutReport = await createWorkerVersion(runOptions({
            apiClient: bare,
            fileSystem: makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' }),
        }));

        assertEqual(null, withoutReport.reconciliation);
    });

    it('forwards deploy: true to createWorkerVersion() and records it in the state', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, deploy: true }));

        const call = apiClient.calls.createWorkerVersion[0];
        const state = JSON.parse(fileSystem.written[STATE_FILEPATH]);

        assertEqual(true, call.options.deploy);
        assertEqual(true, state.deployed);
        assertEqual(true, result.deployed);
    });

    it('throws a UsageError naming an unsupported WORKER_VERSION key, including annotations', async () => {
        const bundleModules = makeBundler('export default 1;');
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const withAnnotations = makeCloudflareConfig();
        withAnnotations.environments.production.WORKER_VERSION.annotations = { 'workers/message': 'hi' };

        const caughtAnnotations = await catchAsyncError(() => {
            return createWorkerVersion(runOptions({ apiClient, bundleModules, cloudflareConfig: withAnnotations }));
        });

        assert(caughtAnnotations, 'expected an error to be thrown');
        assertEqual('UsageError', caughtAnnotations.name);
        assert(
            caughtAnnotations.message.includes('environments.production.WORKER_VERSION.annotations'),
            'expected the message to name the offending path',
        );
        assertEqual(0, apiClient.calls.createWorkerVersion.length);

        const withTypo = makeCloudflareConfig();
        withTypo.environments.production.WORKER_VERSION.compatibilty_date = '2026-08-01';

        const caughtTypo = await catchAsyncError(() => {
            return createWorkerVersion(runOptions({ apiClient, bundleModules, cloudflareConfig: withTypo }));
        });

        assert(caughtTypo, 'expected an error to be thrown');
        assertEqual('UsageError', caughtTypo.name);
        assert(
            caughtTypo.message.includes('environments.production.WORKER_VERSION.compatibilty_date'),
            'expected the message to name the offending path',
        );
    });

    it('uploads to the newly configured Worker when WORKER.name is retargeted', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));
        carryStateForward(fileSystem);

        const config = makeCloudflareConfig();
        config.environments.production.WORKER.name = 'kixx-test-app-2';

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, cloudflareConfig: config }));

        assertEqual('created', result.outcome);
        assertEqual('kixx-test-app-2', result.workerName);
        assertEqual('kixx-test-app', result.retargetedFrom);
        assertEqual(false, result.changes.modules);
        assertEqual(false, result.changes.bindings);
        assertEqual(false, result.changes.config);
        assertEqual(2, apiClient.calls.createWorkerVersion.length);
        assertEqual('kixx-test-app-2', apiClient.calls.createWorkerVersion[1].workerName);
    });

    it('reports retargetedFrom as null when the Worker name is unchanged', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        const first = await createWorkerVersion(runOptions({ apiClient, fileSystem }));
        assertEqual(null, first.retargetedFrom);

        carryStateForward(fileSystem);

        const bundleModules = makeBundler('export default 2;');
        const second = await createWorkerVersion(runOptions({ apiClient, fileSystem, bundleModules }));
        assertEqual(null, second.retargetedFrom);
    });

    it('uploads and deploys on an explicit --deploy even when nothing else changed', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({ createWorkerVersion: async () => ({ id: 'version-id' }) });

        await createWorkerVersion(runOptions({ apiClient, fileSystem }));
        carryStateForward(fileSystem);

        const result = await createWorkerVersion(runOptions({ apiClient, fileSystem, deploy: true }));

        assertEqual('created', result.outcome);
        assertEqual(false, result.changes.modules);
        assertEqual(false, result.changes.bindings);
        assertEqual(false, result.changes.config);
        assertEqual(2, apiClient.calls.createWorkerVersion.length);
        assertEqual(true, apiClient.calls.createWorkerVersion[1].options.deploy);
        assertEqual(true, result.deployed);
    });

    it('writes no state file when createWorkerVersion() fails', async () => {
        const fileSystem = makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' });
        const apiClient = makeApiClient({
            createWorkerVersion: async () => {
                throw new CloudflareApiError('server error', { status: 500, method: 'POST', url: 'x' });
            },
        });

        const caught = await catchAsyncError(() => createWorkerVersion(runOptions({ apiClient, fileSystem })));

        assert(caught, 'expected an error to be thrown');
        assert(!Object.prototype.hasOwnProperty.call(fileSystem.written, STATE_FILEPATH), 'expected no state file written');
    });

});

// A Worker record that has served traffic, with a provisioned namespace for
// each named class under Cloudflare's observed `${workerName}_${className}`
// namespace naming convention.
function deployedWorker(classNames) {
    return {
        id: 'worker-id',
        name: 'kixx-test-app',
        deployed_on: '2026-08-29T16:00:00.000000Z',
        references: {
            durable_objects: classNames.map((className) => ({
                namespace_name: `kixx-test-app_${ className }`,
                namespace_id: `${ className }-namespace-id`,
            })),
        },
    };
}

// Moves the state a run just wrote back to where the next run reads it, so the
// next run compares against it instead of treating everything as changed.
function carryStateForward(fileSystem) {
    fileSystem.files[STATE_FILEPATH] = fileSystem.written[STATE_FILEPATH];
    delete fileSystem.written[STATE_FILEPATH];
}

function withContentStore(config) {
    config.environments.production.CONTENT_STORE = {
        kvBindingName: 'CONTENT_STORE_KV',
        kvNamespaceName: 'kixx-test-content-store',
        kvNamespaceId: 'content-namespace-id',
        durableObjectBindingName: 'CONTENT_STORE_DO',
        durableObjectClassName: 'ContentAddressableIndexStore',
    };

    return config;
}

function runOptions(overrides) {
    return {
        projectDirectory: PROJECT_DIRECTORY,
        environment: ENVIRONMENT,
        cloudflareConfig: makeCloudflareConfig(),
        apiClient: makeApiClient({}),
        bundleModules: makeBundler('export default 1;'),
        fileSystem: makeFileSystem({ [SECRETS_FILEPATH]: 'API_SECRET=shh\n' }),
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

// The plain dotenv file is required and carries nothing a test varies, so it
// is supplied by default; a test naming it overrides the default.
function makeFileSystem(suppliedFiles) {
    const files = { [ENVARS_FILEPATH]: 'TRUST_PROXY=false\n', ...suppliedFiles };
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
        findKVNamespaceByName: [],
        findD1DatabaseByName: [],
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
        async findKVNamespaceByName(title) {
            calls.findKVNamespaceByName.push(title);
            return implementations.findKVNamespaceByName ? implementations.findKVNamespaceByName(title) : null;
        },
        async findD1DatabaseByName(name) {
            calls.findD1DatabaseByName.push(name);
            return implementations.findD1DatabaseByName ? implementations.findD1DatabaseByName(name) : null;
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
