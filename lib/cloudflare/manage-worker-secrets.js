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
import { compareSecretNames, isSecretBinding, readSecretBindingNames } from './worker-secret-names.js';

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
 * Recovers local state for an explicitly selected secret-only version.
 * Requires an existing state record and remote proof that code, runtime,
 * build identity, and non-secret bindings were preserved. Does not deploy.
 * @param {Object} args - Workflow inputs and dependencies.
 * @param {string} args.projectDirectory - Absolute project root.
 * @param {string} args.environment - Cloudflare environment name.
 * @param {Object} args.cloudflareConfig - Project Cloudflare configuration.
 * @param {string} args.versionId - Explicit version to recover, never inferred.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - API client.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<Object>} Recovered state and its filepath.
 * @throws {UsageError} When the selected version cannot be verified as a secret-only change.
 */
export async function recoverSecretVersion(args) {
    const {
        projectDirectory,
        environment,
        cloudflareConfig,
        versionId,
        apiClient,
        fileSystem = defaultFileSystem,
    } = args ?? {};
    if (!isNonEmptyString(environment) || !isNonEmptyString(versionId) || versionId === 'latest') {
        throw new UsageError('Recovery requires --environment and an explicit version ID');
    }

    const workerName = cloudflareConfig?.environments?.[environment]?.WORKER?.name;
    if (!isNonEmptyString(workerName)) {
        throw new UsageError(`Missing configuration: environments.${ environment }.WORKER.name`);
    }
    const state = await readWorkerVersionState({ projectDirectory, environment, fileSystem });
    validateBaseState(state, workerName, environment);
    const baseVersion = await getBaseVersion(apiClient, workerName, state.versionId, { include: 'modules' });
    const version = await getBaseVersion(apiClient, workerName, versionId, { include: 'modules' });
    if (baseVersion.id !== state.versionId || version.id !== versionId) {
        throw new UsageError('Cannot recover state: Cloudflare returned an unexpected version identity');
    }
    await assertLatestVersion(apiClient, workerName, versionId);

    verifyRecoveryCodeAndSettings(baseVersion, version);
    const baseResources = baseVersion.resources;
    const resources = version.resources;
    const baseBindings = baseResources?.bindings ?? baseVersion.bindings;
    const bindings = resources?.bindings ?? version.bindings;
    if (!Array.isArray(baseBindings) || !Array.isArray(bindings)) {
        throw new UsageError('Cannot recover secret-only state without remote bindings lists');
    }
    const build = bindings.find((binding) => binding.name === 'BUILD_ID' && binding.type === 'plain_text');
    const nonSecrets = (items) => items.filter((binding) => !isSecretBinding(binding))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (build?.text !== state.buildId ||
        hashValue(nonSecrets(baseBindings)) !== hashValue(nonSecrets(bindings))) {
        throw new UsageError('Cannot recover secret-only state: BUILD_ID or non-secret bindings differ');
    }
    const declaredNames = await readDeclaredSecretNames({ projectDirectory, fileSystem });
    const { missing, undeclared } = compareSecretNames({
        declaredNames,
        remoteNames: readSecretBindingNames(version),
    });
    if (missing.length > 0) {
        throw new UsageError(`Cannot recover version missing declared secrets: ${ missing.join(', ') }`);
    }
    const createdAt = version.metadata?.created_on ?? version.created_on;
    if (!isNonEmptyString(createdAt)) {
        throw new UsageError('Cannot recover version without its creation timestamp');
    }
    const nextState = {
        ...state,
        versionId,
        createdAt,
        // Recovery does not infer whether a remote version is serving traffic.
        deployed: versionId === state.versionId ? state.deployed : false,
        bindingsHash: hashInheritedBindings({ baseVersion: version, declaredNames, versionId }),
    };
    delete nextState.secretNames;
    await assertLatestVersion(apiClient, workerName, versionId);
    await writeWorkerVersionState({ projectDirectory, environment, state: nextState, fileSystem });
    return {
        ...nextState,
        undeclaredSecretNames: undeclared,
        stateFilepath: getStateFilepath({ projectDirectory, environment }),
    };
}

function verifyRecoveryCodeAndSettings(baseVersion, version) {
    // A shared BUILD_ID alone cannot prove that the remote code stayed the same.
    if (!baseVersion.resources && !version.resources) {
        assertRecoverySettingsEqual('modules', verifiedModules(baseVersion), verifiedModules(version));
        const metadata = new Set([
            'id', 'number', 'created_on', 'modified_on', 'annotations', 'urls',
            'source', 'startup_time_ms', 'author_id', 'author_email', 'metadata',
            'bindings', 'env', 'modules', 'migration_tag', 'exports_reconciliation',
        ]);
        const settings = (value) => Object.fromEntries(
            Object.entries(value).filter(([ name ]) => !metadata.has(name)),
        );
        assertRecoverySettingsEqual('version', settings(baseVersion), settings(version));
        return;
    }
    const baseResources = baseVersion.resources;
    const resources = version.resources;
    if (!isNonEmptyString(baseResources?.script?.etag) || !isNonEmptyString(resources?.script?.etag)) {
        throw new UsageError('Cannot recover secret-only state: resources.script.etag is missing on one or both versions');
    }
    assertRecoverySettingsEqual('resources.script', baseResources.script, resources.script);
    if (!isPlainObject(baseResources.script_runtime) || !isPlainObject(resources.script_runtime)) {
        throw new UsageError('Cannot recover secret-only state: resources.script_runtime is missing on one or both versions');
    }
    assertRecoverySettingsEqual('resources.script_runtime', baseResources.script_runtime, resources.script_runtime);
    assertRecoverySettingsEqual('exports', baseVersion.exports ?? {}, version.exports ?? {});
    assertRecoverySettingsEqual('cache_options', baseVersion.cache_options ?? null, version.cache_options ?? null);
    const resourceSettings = (value) => Object.fromEntries(
        Object.entries(value).filter(([ name ]) => name !== 'bindings'),
    );
    assertRecoverySettingsEqual('resources', resourceSettings(baseResources), resourceSettings(resources));
}

function verifiedModules(version) {
    const modules = version.modules;
    if (!Array.isArray(modules) || modules.length === 0 || modules.some((module) =>
        !isNonEmptyString(module?.name) || !isNonEmptyString(module?.content_type) ||
        !isString(module?.content_base64))) {
        throw new UsageError('Cannot recover secret-only state without complete remote module contents');
    }
    if (new Set(modules.map((module) => module.name)).size !== modules.length) {
        throw new UsageError('Cannot recover secret-only state with duplicate remote module names');
    }
    return modules.map((module) => ({
        name: module.name,
        content_type: module.content_type,
        content_base64: module.content_base64,
    })).sort((a, b) => a.name.localeCompare(b.name));
}

function assertRecoverySettingsEqual(path, recorded, selected) {
    if (hashValue(recorded) === hashValue(selected)) {
        return;
    }
    // Report field names rather than values; settings can contain private data.
    const fields = isPlainObject(recorded) && isPlainObject(selected)
        ? Array.from(new Set([ ...Object.keys(recorded), ...Object.keys(selected) ]))
            .filter((name) => hashValue(recorded[name] ?? null) !== hashValue(selected[name] ?? null))
            .map((name) => `${ path }.${ name }`)
        : [ path ];
    throw new UsageError(`Cannot recover secret-only state: remote settings differ at ${ fields.join(', ') || path }`);
}

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
 * @returns {Promise<Object>} Created version metadata, changed names, and `undeclaredSecretNames`: secrets on the
 *     created version that `example.env.secrets` does not declare, which the next normal build will not inherit.
 *     Never includes values.
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
 * @returns {Promise<Object>} Created version metadata, changed name, and `undeclaredSecretNames` remaining on the
 *     created version.
 * @throws {UsageError} When configuration, declaration, state, or remote-base preflight fails, or the base
 *     version holds no secret by that name.
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

    const baseVersion = await getBaseVersion(apiClient, workerName, state.versionId);
    await assertLatestVersion(apiClient, workerName, state.versionId);

    const baseSecretNames = readSecretBindingNames(baseVersion);
    validateKnownDeletes({ baseSecretNames, operationNames, action, versionId: state.versionId });

    const result = await apiClient.createWorkerSecretVersion(
        workerName,
        operations,
        { command },
    );
    const { undeclared } = compareSecretNames({
        declaredNames,
        remoteNames: applySecretNames(baseSecretNames, operationNames, action),
    });
    const nextState = {
        workerName,
        buildId: state.buildId,
        versionId: result.versionId,
        createdAt: result.createdAt,
        deployed: false,
        modulesHash: state.modulesHash,
        bindingsHash: hashInheritedBindings({
            baseVersion,
            declaredNames,
            versionId: result.versionId,
        }),
        configHash: state.configHash,
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
        undeclaredSecretNames: undeclared,
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

async function getBaseVersion(apiClient, workerName, versionId, options) {
    try {
        return await apiClient.getWorkerVersion(workerName, versionId, options);
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

// Checked against the remote base version, so a typo fails instead of creating
// a pointless version, and a secret set outside this tool can still be deleted.
function validateKnownDeletes(args) {
    const { baseSecretNames, operationNames, action, versionId } = args;

    if (action !== 'delete') {
        return;
    }

    const known = new Set(baseSecretNames);
    for (const name of operationNames) {
        if (!known.has(name)) {
            throw new UsageError(`Secret "${ name }" is not set on Worker version ${ versionId }`);
        }
    }
}

// Hashes inheritance by declared name, not by the names present remotely,
// because a normal build inherits only declared names.
function hashInheritedBindings(args) {
    const { baseVersion, declaredNames, versionId } = args;
    const bindings = (baseVersion.resources?.bindings ?? baseVersion.bindings)
        .filter((binding) => binding?.name !== 'BUILD_ID' && !isSecretBinding(binding))
        .map((binding) => ({ ...binding }));

    declaredNames.forEach((name) => {
        bindings.push({ type: 'inherit', name, version_id: versionId });
    });
    bindings.sort((a, b) => a.name.localeCompare(b.name));

    return hashValue({ bindings, exports: baseVersion?.exports ?? {} });
}
