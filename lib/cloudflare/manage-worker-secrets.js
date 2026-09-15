import { isNonEmptyString, isPlainObject, isString } from 'kixx-assert';
import { hashValue } from '../canonical-hash.js';
import { readDeclaredSecretNames } from '../env-file.js';
import defaultFileSystem from '../file-system.js';
import UsageError from '../usage-error.js';
import {
    getStateFilepath,
    readWorkerVersionState,
    writeWorkerVersionState,
} from './worker-version-state.js';

const RESERVED_NAMES = new Set([ 'BUILD_ID', 'ENVIRONMENT' ]);
const REQUIRED_STATE_STRING_FIELDS = [
    'workerName',
    'buildId',
    'versionId',
    'createdAt',
    'modulesHash',
    'bindingsHash',
    'configHash',
];

/**
 * Applies an additive set of Worker secrets and records the undeployed version.
 * @param {Object} args - Workflow inputs and dependencies.
 * @param {string} args.projectDirectory - Absolute project root.
 * @param {string} args.environment - Cloudflare environment name.
 * @param {Object} args.cloudflareConfig - Parsed project Cloudflare configuration.
 * @param {Object<string, string>} args.secrets - Secret values by declared name.
 * @param {string} args.command - Devkit command recorded in version annotations.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - Cloudflare API client.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<Object>} Created version metadata and changed names, without values.
 * @throws {UsageError} When configuration, declaration, state, or remote-base preflight fails.
 */
export async function setWorkerSecrets(args) {
    const { secrets } = args ?? {};

    if (!isPlainObject(secrets) || Object.keys(secrets).length === 0) {
        throw new UsageError('At least one secret value is required');
    }

    for (const [ name, value ] of Object.entries(secrets)) {
        if (!isString(value)) {
            throw new UsageError(`Secret "${ name }" must have a string value`);
        }
    }

    return await mutateWorkerSecrets({ ...args, operations: secrets, action: 'set' });
}

/**
 * Deletes one no-longer-declared Worker secret and records the undeployed version.
 * @param {Object} args - Workflow inputs and dependencies.
 * @param {string} args.projectDirectory - Absolute project root.
 * @param {string} args.environment - Cloudflare environment name.
 * @param {Object} args.cloudflareConfig - Parsed project Cloudflare configuration.
 * @param {string} args.name - Secret name to delete.
 * @param {string} args.command - Devkit command recorded in version annotations.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - Cloudflare API client.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<Object>} Created version metadata and changed name.
 * @throws {UsageError} When configuration, declaration, state, or remote-base preflight fails.
 */
export async function deleteWorkerSecret(args) {
    const { name } = args ?? {};

    if (!isNonEmptyString(name)) {
        throw new UsageError('A secret name is required');
    }

    return await mutateWorkerSecrets({ ...args, operations: { [name]: null }, action: 'delete' });
}

async function mutateWorkerSecrets(args) {
    const {
        projectDirectory,
        environment,
        cloudflareConfig,
        apiClient,
        command,
        operations,
        action,
        fileSystem = defaultFileSystem,
    } = args;

    if (!isNonEmptyString(environment)) {
        throw new UsageError('The --environment option is required');
    }

    const environmentConfig = cloudflareConfig?.environments?.[environment];
    if (!isPlainObject(environmentConfig)) {
        throw new UsageError(`Missing configuration: environments.${ environment }`);
    }

    const workerName = environmentConfig.WORKER?.name;
    if (!isNonEmptyString(workerName)) {
        throw new UsageError(`Missing configuration: environments.${ environment }.WORKER.name`);
    }
    if (!isNonEmptyString(command)) {
        throw new UsageError('The invoking command name is required');
    }

    const declaredNames = await readDeclaredSecretNames({ projectDirectory, fileSystem });
    const operationNames = Object.keys(operations).sort();
    validateOperationNames({ action, operationNames, declaredNames });

    const state = await readWorkerVersionState({ projectDirectory, environment, fileSystem });
    validateBaseState(state, workerName, environment);
    validateKnownDeletes(state.secretNames ?? [], operationNames, action);

    const baseVersion = await getBaseVersion(apiClient, workerName, state.versionId);
    await assertLatestVersion(apiClient, workerName, state.versionId);

    const result = await apiClient.createWorkerSecretVersion(
        workerName,
        operations,
        { command },
    );
    const secretNames = applySecretNames(state.secretNames ?? [], operationNames, action);
    const nextState = {
        workerName,
        buildId: state.buildId,
        versionId: result.versionId,
        createdAt: result.createdAt,
        deployed: false,
        modulesHash: state.modulesHash,
        bindingsHash: hashInheritedBindings({
            baseVersion,
            currentSecretNames: state.secretNames ?? [],
            nextSecretNames: secretNames,
            versionId: result.versionId,
        }),
        configHash: state.configHash,
        secretNames,
    };

    try {
        await writeWorkerVersionState({
            projectDirectory,
            environment,
            state: nextState,
            fileSystem,
        });
    } catch (cause) {
        throw new Error(
            `Created remote Worker version ${ result.versionId }, but could not write its local state. ` +
            'Recover the state before another Worker operation.',
            { cause },
        );
    }

    return {
        environment,
        workerName,
        changedSecretNames: operationNames,
        versionId: result.versionId,
        createdAt: result.createdAt,
        buildId: state.buildId,
        stateFilepath: getStateFilepath({ projectDirectory, environment }),
        deployed: false,
    };
}

function validateOperationNames(args) {
    const { action, operationNames, declaredNames } = args;
    const declared = new Set(declaredNames);

    for (const name of operationNames) {
        if (RESERVED_NAMES.has(name)) {
            throw new UsageError(`Secret name "${ name }" is reserved by the Worker version workflow`);
        }

        if (action === 'set' && !declared.has(name)) {
            throw new UsageError(`Secret "${ name }" is not declared in example.env.secrets`);
        }

        if (action === 'delete' && declared.has(name)) {
            throw new UsageError(
                `Secret "${ name }" is still required by example.env.secrets; remove or comment out its declaration first`,
            );
        }
    }
}

function validateBaseState(state, workerName, environment) {
    if (!state) {
        throw new UsageError(`No Worker version is recorded for environment "${ environment }"`);
    }

    for (const field of REQUIRED_STATE_STRING_FIELDS) {
        if (!isNonEmptyString(state[field])) {
            throw new UsageError(`Cloudflare state for environment "${ environment }" requires "${ field }"`);
        }
    }

    if (state.workerName !== workerName) {
        throw new UsageError(
            `Cloudflare state records Worker "${ state.workerName }", but configuration names "${ workerName }"`,
        );
    }
}

async function getBaseVersion(apiClient, workerName, versionId) {
    try {
        return await apiClient.getWorkerVersion(workerName, versionId);
    } catch (error) {
        if (error.status === 404) {
            throw new UsageError(
                `Recorded Worker version ${ versionId } does not exist for Worker "${ workerName }"`,
                { cause: error },
            );
        }

        throw error;
    }
}

async function assertLatestVersion(apiClient, workerName, versionId) {
    const [ latest ] = await apiClient.listWorkerVersions(workerName, { page: 1, per_page: 1 });

    if (latest?.id !== versionId) {
        const latestId = latest?.id ?? 'none';
        throw new UsageError(
            `Cloudflare state is stale for Worker "${ workerName }": ` +
            `recorded version ${ versionId }, latest remote version ${ latestId }`,
        );
    }
}

function applySecretNames(currentNames, operationNames, action) {
    const names = new Set(currentNames);

    for (const name of operationNames) {
        if (action === 'delete') {
            names.delete(name);
        } else {
            names.add(name);
        }
    }

    return [ ...names ].sort();
}

function validateKnownDeletes(currentNames, operationNames, action) {
    if (action !== 'delete') {
        return;
    }

    const known = new Set(currentNames);
    for (const name of operationNames) {
        if (!known.has(name)) {
            throw new UsageError(`Secret "${ name }" is not recorded in local Worker state`);
        }
    }
}

function hashInheritedBindings(args) {
    const {
        baseVersion,
        currentSecretNames,
        nextSecretNames,
        versionId,
    } = args;
    const currentSecrets = new Set(currentSecretNames);
    const bindings = Array.isArray(baseVersion?.bindings)
        ? baseVersion.bindings.filter((binding) => {
            return binding?.name !== 'BUILD_ID' &&
                !currentSecrets.has(binding?.name) &&
                binding?.type !== 'secret_text' &&
                binding?.type !== 'secret_key';
        }).map((binding) => ({ ...binding }))
        : [];

    nextSecretNames.forEach((name) => {
        bindings.push({ type: 'inherit', name, version_id: versionId });
    });
    bindings.sort((a, b) => a.name.localeCompare(b.name));

    return hashValue({ bindings, exports: baseVersion?.exports ?? {} });
}
