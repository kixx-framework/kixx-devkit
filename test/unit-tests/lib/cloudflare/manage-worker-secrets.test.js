import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import {
    deleteWorkerSecret,
    recoverSecretVersion,
    setWorkerSecrets,
} from '../../../../lib/cloudflare/manage-worker-secrets.js';

const PROJECT_DIRECTORY = '/app';
const ENVIRONMENT = 'production';
const DECLARATIONS_FILEPATH = '/app/example.env.secrets';
const STATE_FILEPATH = '/app/.kixx/cloudflare-state.production.json';
const BASE_STATE = {
    workerName: 'example-worker',
    buildId: 'existing-build-id',
    versionId: 'base-version-id',
    createdAt: '2026-09-14T12:00:00.000Z',
    deployed: false,
    modulesHash: 'modules-hash',
    bindingsHash: 'bindings-hash',
    configHash: 'config-hash',
};

describe('manage-worker-secrets', ({ it }) => {
    it('recovers the modern version format by requesting and comparing module contents', async () => {
        const fileSystem = makeFileSystem();
        const apiClient = modernRecoveryApiClient();
        const result = await recoverSecretVersion(runOptions({
            apiClient, fileSystem, versionId: 'recovered-version',
        }));
        assertEqual('recovered-version', result.versionId);
        assertEqual(1, fileSystem.writeCount);
        assertEqual('modules', apiClient.calls.getWorkerVersion[0].options.include);
        assertEqual('modules', apiClient.calls.getWorkerVersion[1].options.include);
    });

    it('rejects modern versions with missing or changed modules or changed runtime settings', async () => {
        const changes = [
            (version) => {
                delete version.modules;
            },
            (version) => {
                version.modules = [];
            },
            (version) => {
                version.modules[0].content_base64 = 'Y2hhbmdlZA==';
            },
            (version) => {
                delete version.modules[0].content_base64;
            },
            (version) => {
                version.modules.push({ ...version.modules[0] });
            },
            (version) => {
                version.compatibility_date = '2026-09-16';
            },
            (version) => {
                version.main_module = 'different.js';
            },
        ];
        for (const change of changes) {
            const fileSystem = makeFileSystem();
            const caught = await catchAsyncError(() => recoverSecretVersion(runOptions({
                apiClient: modernRecoveryApiClient(change), fileSystem, versionId: 'recovered-version',
            })));
            assertEqual('UsageError', caught.name);
            assertEqual(0, fileSystem.writeCount);
        }
    });

    it('recovers an explicit untagged secret-only version without a remote mutation', async () => {
        const fileSystem = makeFileSystem();
        const apiClient = recoveryApiClient();
        const result = await recoverSecretVersion(runOptions({
            apiClient, fileSystem, versionId: 'recovered-version',
        }));
        const state = JSON.parse(fileSystem.files[STATE_FILEPATH]);
        assertEqual('recovered-version', state.versionId);
        assertEqual(BASE_STATE.buildId, state.buildId);
        assertEqual(BASE_STATE.modulesHash, state.modulesHash);
        assertEqual(BASE_STATE.configHash, state.configHash);
        assertEqual(false, state.deployed);
        assertEqual(STATE_FILEPATH, result.stateFilepath);
        assertEqual(0, apiClient.calls.createWorkerSecretVersion.length);
        assertEqual(1, fileSystem.writeCount);
    });

    it('refuses recovery when identity, code, runtime, bindings, or declared secrets cannot be verified', async () => {
        const changes = [
            (version) => {
                version.resources.script.etag = 'different';
            },
            (version) => {
                delete version.resources.script.etag;
            },
            (version) => {
                version.resources.script_runtime.compatibility_date = '2026-09-16';
            },
            (version) => {
                version.resources.bindings[0].text = 'different-build';
            },
            (version) => {
                version.resources.bindings[1].text = 'different-value';
            },
            (version) => {
                version.resources.bindings.pop();
            },
            (version) => {
                delete version.metadata.created_on;
            },
        ];
        for (const change of changes) {
            const fileSystem = makeFileSystem();
            const caught = await catchAsyncError(() => recoverSecretVersion(runOptions({
                apiClient: recoveryApiClient(change), fileSystem, versionId: 'recovered-version',
            })));
            assertEqual('UsageError', caught.name);
            assertEqual(0, fileSystem.writeCount);
        }
    });

    it('refuses recovery of a version that is no longer latest', async () => {
        const fileSystem = makeFileSystem();
        const apiClient = recoveryApiClient();
        apiClient.listWorkerVersions = async () => [ { id: 'other-version' } ];
        const caught = await catchAsyncError(() => recoverSecretVersion(runOptions({
            apiClient, fileSystem, versionId: 'recovered-version',
        })));
        assertEqual('UsageError', caught.name);
        assertEqual(0, fileSystem.writeCount);
    });

    it('identifies a differing script field without exposing its values', async () => {
        const fileSystem = makeFileSystem();
        const apiClient = recoveryApiClient((version) => {
            version.resources.script.last_deployed_from = 'private-provenance';
        });
        const caught = await catchAsyncError(() => recoverSecretVersion(runOptions({
            apiClient, fileSystem, versionId: 'recovered-version',
        })));
        assert(caught.message.includes('resources.script.last_deployed_from'));
        assert(!caught.message.includes('private-provenance'));
        assertEqual(0, fileSystem.writeCount);
    });

    it('requires an explicit recovery ID and an existing valid state record', async () => {
        for (const options of [ { versionId: 'latest' }, { versionId: '' },
            { versionId: 'recovered-version', state: null } ]) {
            const fileSystem = makeFileSystem({ state: options.state === null ? null : BASE_STATE });
            const caught = await catchAsyncError(() => recoverSecretVersion(runOptions({
                ...options, apiClient: recoveryApiClient(), fileSystem,
            })));
            assertEqual('UsageError', caught.name);
            assertEqual(0, fileSystem.writeCount);
        }
    });

    it('sets one declared secret additively and writes value-free state', async () => {
        const apiClient = makeApiClient();
        const fileSystem = makeFileSystem();

        const result = await setWorkerSecrets(runOptions({
            apiClient,
            fileSystem,
            secrets: { API_KEY: 'FAKE_SECRET_VALUE' },
        }));

        assertEqual('new-version-id', result.versionId);
        assertEqual('existing-build-id', result.buildId);
        assertEqual(false, result.deployed);
        assertEqual('API_KEY', result.changedSecretNames.join(','));
        assertEqual(1, apiClient.calls.createWorkerSecretVersion.length);
        assertEqual(1, fileSystem.writeCount);

        const mutation = apiClient.calls.createWorkerSecretVersion[0];
        assertEqual('FAKE_SECRET_VALUE', mutation.operations.API_KEY);
        assertEqual(0, result.undeclaredSecretNames.length);
        const state = JSON.parse(fileSystem.files[STATE_FILEPATH]);
        assertEqual(undefined, state.secretNames);
        assertEqual('existing-build-id', state.buildId);
        assertEqual('modules-hash', state.modulesHash);
        assertEqual('config-hash', state.configHash);
        assertEqual('new-version-id', state.versionId);
        assertEqual(false, state.deployed);
        assert(!fileSystem.files[STATE_FILEPATH].includes('FAKE_SECRET_VALUE'), 'expected no value in state');
        assert(!JSON.stringify(result).includes('FAKE_SECRET_VALUE'), 'expected no value in result');
    });

    it('bulk sets declared secrets in one mutation with sorted changed names', async () => {
        const apiClient = makeApiClient();
        const fileSystem = makeFileSystem({
            declarations: [ 'ZETA=', 'ALPHA=', 'EXISTING=' ].join('\n'),
        });

        const result = await setWorkerSecrets(runOptions({
            apiClient,
            fileSystem,
            secrets: { ZETA: 'fake-zeta', ALPHA: '', EXISTING: 'fake-replacement' },
        }));

        assertEqual(1, apiClient.calls.createWorkerSecretVersion.length);
        assertEqual('ALPHA,EXISTING,ZETA', result.changedSecretNames.join(','));
    });

    it('reports remote secrets the declaration file does not declare', async () => {
        const apiClient = makeApiClient({
            async getWorkerVersion(_workerName, versionId) {
                return {
                    id: versionId,
                    bindings: [
                        { type: 'secret_text', name: 'EXISTING' },
                        { type: 'secret_text', name: 'OLD_SECRET' },
                        { type: 'plain_text', name: 'PLAIN_VALUE', text: 'visible' },
                    ],
                };
            },
        });

        const result = await setWorkerSecrets(runOptions({
            apiClient,
            secrets: { API_KEY: 'FAKE_SECRET_VALUE' },
        }));

        assertEqual('OLD_SECRET', result.undeclaredSecretNames.join(','));
    });

    it('deletes a secret present on the remote base version after its declaration is removed', async () => {
        const apiClient = makeApiClient();
        const fileSystem = makeFileSystem({
            declarations: 'API_KEY=',
            state: { ...BASE_STATE, secretNames: [] },
        });

        const result = await deleteWorkerSecret(runOptions({
            apiClient,
            fileSystem,
            name: 'EXISTING',
            command: 'kixx.js cloudflare delete-secret',
        }));

        assertEqual('EXISTING', result.changedSecretNames.join(','));
        assertEqual(null, apiClient.calls.createWorkerSecretVersion[0].operations.EXISTING);
        assertEqual(0, result.undeclaredSecretNames.length);
    });

    it('rejects missing environment and environment configuration before mutation', async () => {
        const cases = [
            { environment: undefined },
            { cloudflareConfig: { environments: {} } },
            { cloudflareConfig: { environments: { production: {} } } },
        ];

        for (const overrides of cases) {
            const apiClient = makeApiClient();
            const caught = await catchAsyncError(() => {
                return setWorkerSecrets(runOptions({
                    ...overrides,
                    apiClient,
                    secrets: { API_KEY: 'fake-value' },
                }));
            });

            assertEqual('UsageError', caught.name);
            assertEqual(0, apiClient.calls.createWorkerSecretVersion.length);
        }
    });

    it('rejects undeclared and reserved set names before remote reads', async () => {
        for (const name of [ 'UNDECLARED', 'BUILD_ID', 'ENVIRONMENT' ]) {
            const apiClient = makeApiClient();
            const caught = await catchAsyncError(() => {
                return setWorkerSecrets(runOptions({
                    apiClient,
                    secrets: { [name]: 'FAKE_SECRET_VALUE' },
                    declarations: name === 'UNDECLARED'
                        ? 'API_KEY=example'
                        : `${ name }=example`,
                }));
            });

            assertEqual('UsageError', caught.name);
            assertEqual(0, apiClient.calls.getWorkerVersion.length);
            assertEqual(0, apiClient.calls.createWorkerSecretVersion.length);
            assert(!caught.message.includes('FAKE_SECRET_VALUE'), 'expected value-free error');
        }
    });

    it('rejects deletion while declared and deletion absent from the base version before mutation', async () => {
        const cases = [
            { declarations: 'EXISTING=', message: 'still required' },
            { declarations: '', name: 'UNKNOWN', message: 'not set on Worker version base-version-id' },
            { declarations: '', name: 'PLAIN_VALUE', message: 'not set on Worker version base-version-id' },
        ];

        for (const testCase of cases) {
            const apiClient = makeApiClient();
            const fileSystem = makeFileSystem({ declarations: testCase.declarations });
            const caught = await catchAsyncError(() => {
                return deleteWorkerSecret(runOptions({
                    apiClient,
                    fileSystem,
                    name: testCase.name ?? 'EXISTING',
                }));
            });

            assertEqual('UsageError', caught.name);
            assert(caught.message.includes(testCase.message), 'expected deletion guard explanation');
            assertEqual(0, apiClient.calls.createWorkerSecretVersion.length);
        }
    });

    it('rejects missing, incomplete, and wrong-Worker state before mutation', async () => {
        const cases = [
            null,
            { ...BASE_STATE, versionId: '' },
            { ...BASE_STATE, workerName: 'other-worker' },
        ];

        for (const state of cases) {
            const apiClient = makeApiClient();
            const fileSystem = makeFileSystem({ state });
            const caught = await catchAsyncError(() => {
                return setWorkerSecrets(runOptions({
                    apiClient,
                    fileSystem,
                    secrets: { API_KEY: 'fake-value' },
                }));
            });

            assertEqual('UsageError', caught.name);
            assertEqual(0, apiClient.calls.createWorkerSecretVersion.length);
        }
    });

    it('rejects an absent exact base version and a stale latest version', async () => {
        const absentClient = makeApiClient({
            async getWorkerVersion() {
                const error = new Error('not found');
                error.status = 404;
                throw error;
            },
        });
        const absent = await catchAsyncError(() => {
            return setWorkerSecrets(runOptions({
                apiClient: absentClient,
                secrets: { API_KEY: 'fake-value' },
            }));
        });

        assertEqual('UsageError', absent.name);
        assert(absent.message.includes('base-version-id'), 'expected missing base ID');
        assertEqual(0, absentClient.calls.createWorkerSecretVersion.length);

        const staleClient = makeApiClient({
            async listWorkerVersions() {
                return [ { id: 'intervening-version-id' } ];
            },
        });
        const stale = await catchAsyncError(() => {
            return setWorkerSecrets(runOptions({
                apiClient: staleClient,
                secrets: { API_KEY: 'fake-value' },
            }));
        });

        assertEqual('UsageError', stale.name);
        assert(stale.message.includes('stale'), 'expected stale-state explanation');
        assert(stale.message.includes('intervening-version-id'), 'expected latest version ID');
        assertEqual(0, staleClient.calls.createWorkerSecretVersion.length);
    });

    it('leaves state unchanged when the remote mutation fails', async () => {
        const fileSystem = makeFileSystem();
        const originalState = fileSystem.files[STATE_FILEPATH];
        const apiClient = makeApiClient({
            async createWorkerSecretVersion() {
                throw new Error('remote failed');
            },
        });

        const caught = await catchAsyncError(() => {
            return setWorkerSecrets(runOptions({
                apiClient,
                fileSystem,
                secrets: { API_KEY: 'FAKE_SECRET_VALUE' },
            }));
        });

        assertEqual('remote failed', caught.message);
        assertEqual(originalState, fileSystem.files[STATE_FILEPATH]);
        assertEqual(0, fileSystem.writeCount);
    });

    it('reports the created version ID when the state write fails', async () => {
        const fileSystem = makeFileSystem({ writeError: new Error('disk full') });
        const apiClient = makeApiClient();

        const caught = await catchAsyncError(() => {
            return setWorkerSecrets(runOptions({
                apiClient,
                fileSystem,
                secrets: { API_KEY: 'FAKE_SECRET_VALUE' },
            }));
        });

        assert(caught.message.includes('new-version-id'), 'expected recovery version ID');
        assert(caught.message.includes('Recover'), 'expected recovery direction');
        assert(!caught.message.includes('FAKE_SECRET_VALUE'), 'expected value-free error');
        assertEqual(1, apiClient.calls.createWorkerSecretVersion.length);
        assertEqual(1, fileSystem.writeCount);
    });

    it('hashes declared inheritance regardless of which secrets the base version holds', async () => {
        const withSecret = makeFileSystem();
        const withoutSecret = makeFileSystem();

        await setWorkerSecrets(runOptions({
            fileSystem: withSecret,
            secrets: { API_KEY: 'FAKE_SECRET_VALUE' },
        }));
        await setWorkerSecrets(runOptions({
            fileSystem: withoutSecret,
            secrets: { API_KEY: 'FAKE_SECRET_VALUE' },
            apiClient: makeApiClient({
                async getWorkerVersion(_workerName, versionId) {
                    return {
                        id: versionId,
                        bindings: [
                            { type: 'plain_text', name: 'BUILD_ID', text: 'existing-build-id' },
                            { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
                            { type: 'plain_text', name: 'PLAIN_VALUE', text: 'visible' },
                            { type: 'secret_text', name: 'UNDECLARED_SECRET' },
                        ],
                    };
                },
            }),
        }));

        const first = JSON.parse(withSecret.files[STATE_FILEPATH]);
        const second = JSON.parse(withoutSecret.files[STATE_FILEPATH]);
        assertEqual(first.bindingsHash, second.bindingsHash);
    });

    it('hashes secret names and inheritance provenance without secret values', async () => {
        const firstFileSystem = makeFileSystem();
        const secondFileSystem = makeFileSystem();

        await setWorkerSecrets(runOptions({
            apiClient: makeApiClient(),
            fileSystem: firstFileSystem,
            secrets: { API_KEY: 'FIRST_FAKE_VALUE' },
        }));
        await setWorkerSecrets(runOptions({
            apiClient: makeApiClient(),
            fileSystem: secondFileSystem,
            secrets: { API_KEY: 'SECOND_FAKE_VALUE' },
        }));

        const first = JSON.parse(firstFileSystem.files[STATE_FILEPATH]);
        const second = JSON.parse(secondFileSystem.files[STATE_FILEPATH]);
        assertEqual(first.bindingsHash, second.bindingsHash);
        assert(!firstFileSystem.files[STATE_FILEPATH].includes('FIRST_FAKE_VALUE'));
        assert(!secondFileSystem.files[STATE_FILEPATH].includes('SECOND_FAKE_VALUE'));
    });
});

function runOptions(overrides) {
    const options = overrides ?? {};
    const fileSystem = options.fileSystem ?? makeFileSystem({
        declarations: options.declarations,
        state: options.state,
    });

    return {
        projectDirectory: PROJECT_DIRECTORY,
        environment: ENVIRONMENT,
        cloudflareConfig: {
            environments: {
                production: { WORKER: { name: 'example-worker' } },
            },
        },
        apiClient: makeApiClient(),
        command: 'kixx.js cloudflare set-secrets',
        fileSystem,
        ...options,
    };
}

function makeApiClient(overrides) {
    const calls = {
        getWorkerVersion: [],
        listWorkerVersions: [],
        createWorkerSecretVersion: [],
    };
    const implementations = overrides ?? {};

    return {
        calls,
        async getWorkerVersion(workerName, versionId, options) {
            calls.getWorkerVersion.push({ workerName, versionId, options });
            if (implementations.getWorkerVersion) {
                return await implementations.getWorkerVersion(workerName, versionId);
            }
            return {
                id: versionId,
                bindings: [
                    { type: 'plain_text', name: 'BUILD_ID', text: 'existing-build-id' },
                    { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
                    { type: 'plain_text', name: 'PLAIN_VALUE', text: 'visible' },
                    { type: 'secret_text', name: 'EXISTING' },
                ],
                exports: {},
            };
        },
        async listWorkerVersions(workerName, options) {
            calls.listWorkerVersions.push({ workerName, options });
            if (implementations.listWorkerVersions) {
                return await implementations.listWorkerVersions(workerName, options);
            }
            return [ { id: 'base-version-id' } ];
        },
        async createWorkerSecretVersion(workerName, operations, options) {
            calls.createWorkerSecretVersion.push({ workerName, operations, options });
            if (implementations.createWorkerSecretVersion) {
                return await implementations.createWorkerSecretVersion(workerName, operations, options);
            }
            return {
                versionId: 'new-version-id',
                createdAt: '2026-09-15T12:00:00.000Z',
            };
        },
    };
}

function modernRecoveryApiClient(change) {
    const client = recoveryApiClient();
    const getVersion = client.getWorkerVersion.bind(client);
    client.getWorkerVersion = async (workerName, versionId, options) => {
        const legacy = await getVersion(workerName, versionId, options);
        const version = {
            id: versionId,
            number: versionId === 'recovered-version' ? 2 : 1,
            created_on: legacy.metadata.created_on,
            source: versionId === 'recovered-version' ? 'api' : 'upload',
            bindings: legacy.resources.bindings,
            compatibility_date: legacy.resources.script_runtime.compatibility_date,
            main_module: 'worker.js',
            modules: [ { name: 'worker.js', content_type: 'application/javascript+module', content_base64: 'Y29kZQ==' } ],
        };
        if (change && versionId === 'recovered-version') {
            change(version);
        }
        return version;
    };
    return client;
}

function makeFileSystem(options) {
    const {
        declarations = [ 'API_KEY=example', 'EXISTING=example' ].join('\n'),
        state = BASE_STATE,
        writeError = null,
    } = options ?? {};
    const files = { [DECLARATIONS_FILEPATH]: declarations };
    if (state) {
        files[STATE_FILEPATH] = JSON.stringify(state);
    }

    return {
        files,
        writeCount: 0,
        async isFile(filepath) {
            return Object.prototype.hasOwnProperty.call(files, filepath);
        },
        async readFile(filepath) {
            if (!Object.prototype.hasOwnProperty.call(files, filepath)) {
                throw new Error(`missing ${ filepath }`);
            }
            return files[filepath];
        },
        async writeFile(filepath, contents) {
            this.writeCount += 1;
            if (writeError) {
                throw writeError;
            }
            files[filepath] = contents;
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

function recoveryApiClient(change) {
    return makeApiClient({
        async listWorkerVersions() {
            return [ { id: 'recovered-version' } ];
        },
        async getWorkerVersion(_workerName, versionId) {
            const version = {
                id: versionId,
                metadata: { created_on: '2026-09-15T12:00:00.000Z' },
                resources: {
                    script: { etag: 'same-code', handlers: [ 'fetch' ] },
                    script_runtime: { compatibility_date: '2026-08-01' },
                    bindings: [
                        { type: 'plain_text', name: 'BUILD_ID', text: BASE_STATE.buildId },
                        { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
                        { type: 'secret_text', name: 'EXISTING' },
                        { type: 'secret_text', name: 'API_KEY' },
                    ],
                },
            };
            if (change && versionId === 'recovered-version') {
                change(version);
            }
            return version;
        },
    });
}
