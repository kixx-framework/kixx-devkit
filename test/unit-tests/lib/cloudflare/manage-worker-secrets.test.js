import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import {
    deleteWorkerSecret,
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
    secretNames: [ 'EXISTING' ],
};

describe('manage-worker-secrets', ({ it }) => {
    it('sets one declared secret additively and writes name-only state', async () => {
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
        const state = JSON.parse(fileSystem.files[STATE_FILEPATH]);
        assertEqual('API_KEY,EXISTING', state.secretNames.join(','));
        assertEqual('existing-build-id', state.buildId);
        assertEqual('modules-hash', state.modulesHash);
        assertEqual('config-hash', state.configHash);
        assertEqual('new-version-id', state.versionId);
        assertEqual(false, state.deployed);
        assert(!fileSystem.files[STATE_FILEPATH].includes('FAKE_SECRET_VALUE'), 'expected no value in state');
        assert(!JSON.stringify(result).includes('FAKE_SECRET_VALUE'), 'expected no value in result');
    });

    it('bulk sets declared secrets in one mutation with stable state ordering', async () => {
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
        const state = JSON.parse(fileSystem.files[STATE_FILEPATH]);
        assertEqual('ALPHA,EXISTING,ZETA', state.secretNames.join(','));
    });

    it('deletes only a known secret after its declaration is removed', async () => {
        const apiClient = makeApiClient();
        const fileSystem = makeFileSystem({ declarations: 'API_KEY=' });

        const result = await deleteWorkerSecret(runOptions({
            apiClient,
            fileSystem,
            name: 'EXISTING',
            command: 'kixx.js cloudflare delete-secret',
        }));

        assertEqual('EXISTING', result.changedSecretNames.join(','));
        assertEqual(null, apiClient.calls.createWorkerSecretVersion[0].operations.EXISTING);
        const state = JSON.parse(fileSystem.files[STATE_FILEPATH]);
        assertEqual(0, state.secretNames.length);
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

    it('rejects deletion while declared and deletion unknown to state before mutation', async () => {
        const cases = [
            { declarations: 'EXISTING=', message: 'still required' },
            { declarations: '', name: 'UNKNOWN', message: 'not recorded' },
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
        async getWorkerVersion(workerName, versionId) {
            calls.getWorkerVersion.push({ workerName, versionId });
            if (implementations.getWorkerVersion) {
                return await implementations.getWorkerVersion(workerName, versionId);
            }
            return {
                id: versionId,
                bindings: [
                    { type: 'plain_text', name: 'BUILD_ID', text: 'existing-build-id' },
                    { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
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
