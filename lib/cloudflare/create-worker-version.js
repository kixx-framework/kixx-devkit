import path from 'node:path';
import { isNonEmptyString } from 'kixx-assert';
import UsageError from '../usage-error.js';
import defaultFileSystem from '../file-system.js';
import defaultBundleModules from '../bundler/bundle-modules.js';
import { hashValue } from '../canonical-hash.js';
import { readEnvFiles } from '../env-file.js';
import CloudflareWorkerVersion from './cloudflare-worker-version.js';
import { getStateFilepath, readWorkerVersionState, writeWorkerVersionState } from './worker-version-state.js';
import { toWorkerModules, hashWorkerModules } from './worker-modules.js';
import { buildWorkerBindings } from './worker-bindings.js';
import { buildDurableObjectExports } from './durable-object-exports.js';
import { readWorkerRecord } from './worker-record.js';
import { resolveResources } from './provision-resources.js';
import { formatBuildId } from './build-id.js';

const EXTERNALS = [ 'node:', 'cloudflare:' ];
const TRIGGERED_BY = 'kixx.js cloudflare create-worker-version';

// annotations is deliberately excluded: this command generates workers/tag
// and workers/triggered_by itself and overwrites whatever WORKER_VERSION
// carries, so an authored annotations block would be hashed into configHash
// and then silently discarded rather than ever reaching Cloudflare.
const WORKER_VERSION_KEYS = [
    'compatibility_date',
    'compatibility_flags',
    'limits',
    'placement',
    'cache_options',
];

/**
 * Turns a Kixx application's source tree into a Cloudflare Worker version and
 * uploads it. Composes every module in `lib/cloudflare/` into the documented
 * pipeline and owns the idempotency decision: given an environment, this
 * either skips, reports resource ids the configuration is missing and stops,
 * or creates a version and records the new state.
 * @module create-worker-version
 */

/**
 * @typedef {Object} CreateWorkerVersionResult
 * @property {'skipped'|'created'|'resources-resolved'} outcome - What happened.
 * @property {string} environment - Environment name.
 * @property {string} workerName - Worker name.
 * @property {string} stateFilepath - Absolute path to the state file for this environment.
 * @property {Array<import('./provision-resources.js').ResolvedResource>} resolvedResources - Resources whose
 *     id is missing from the configuration. Empty unless `outcome` is `resources-resolved`.
 * @property {{ modules: boolean, bindings: boolean, config: boolean }} changes - Which hashes differed from the recorded state.
 * @property {number} moduleCount - Number of modules bundled.
 * @property {string|null} buildId - `BUILD_ID` of the created version, or `null` when nothing was created.
 * @property {string|null} versionId - Cloudflare version identifier, or `null` when nothing was created.
 * @property {boolean} deployed - Whether the created version was deployed.
 * @property {string|null} retargetedFrom - The Worker name recorded in the previous state, when it differs from
 *     the configured Worker name, or `null` otherwise. Names the Worker this environment's local state still
 *     believes it owns.
 * @property {string[]|null} forcedDeploymentClasses - Durable Object classes whose missing namespaces forced a
 *     deployment the caller did not request, or `null` when the deployment was requested or did not happen.
 * @property {Object|null} reconciliation - Cloudflare's `exports_reconciliation` report, or `null`. Absent on an
 *     undeployed upload, which is normal rather than an error.
 */

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {Object} args.cloudflareConfig - Parsed `cloudflare-config.js` default export.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - Cloudflare API client.
 * @param {boolean} [args.force=false] - Upload even when nothing changed.
 * @param {boolean} [args.deploy=false] - Route all traffic to the created version.
 * @param {Function} [args.bundleModules] - Bundler, defaulting to `bundleModules()` from `lib/bundler/`.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @param {() => Date} [args.now] - Clock, defaulting to `() => new Date()`.
 * @returns {Promise<CreateWorkerVersionResult>} The outcome of this call.
 * @throws {UsageError} When configuration is invalid, the Worker does not
 *     exist, or the version must be deployed to provision a Durable Object
 *     namespace on a Worker that is already serving traffic.
 */
export async function createWorkerVersion(args) {
    const {
        projectDirectory,
        environment,
        cloudflareConfig,
        apiClient,
        force = false,
        deploy = false,
        bundleModules = defaultBundleModules,
        fileSystem = defaultFileSystem,
        now = () => new Date(),
    } = args ?? {};

    const environmentConfig = cloudflareConfig.environments?.[environment];

    if (!environmentConfig) {
        throw new UsageError(`Missing configuration: environments.${ environment }`);
    }

    if (!isNonEmptyString(environmentConfig.WORKER?.name)) {
        throw new UsageError(`Missing configuration: environments.${ environment }.WORKER.name`);
    }

    assertKnownWorkerVersionKeys(environmentConfig.WORKER_VERSION, environment);

    const workerName = environmentConfig.WORKER.name;
    const stateFilepath = getStateFilepath({ projectDirectory, environment });

    const worker = await fetchWorker(apiClient, workerName, environment);
    const { deployed: workerIsDeployed, provisionedClasses } = readWorkerRecord(worker, workerName);

    const { resolved } = await resolveResources({ environmentConfig, apiClient });

    // Resource ids are never written back into cloudflare-config.js, so a run
    // that resolved any of them stops here: buildWorkerBindings() would throw
    // on the null id still in the configuration.
    if (resolved.length > 0) {
        return {
            outcome: 'resources-resolved',
            environment,
            workerName,
            stateFilepath,
            resolvedResources: resolved,
            changes: { modules: false, bindings: false, config: false },
            moduleCount: 0,
            buildId: null,
            versionId: null,
            deployed: false,
            retargetedFrom: null,
            forcedDeploymentClasses: null,
            reconciliation: null,
        };
    }

    const { envars, secrets } = await readEnvFiles({ projectDirectory, environment, fileSystem });
    const state = await readWorkerVersionState({ projectDirectory, environment, fileSystem });

    const bindings = buildWorkerBindings({ environmentConfig, environment, envars, secrets });
    const { exports, liveClasses } = buildDurableObjectExports({ environmentConfig });

    // The exports map is folded into the bindings hash rather than given a
    // fourth one. Under the declarative scheme the map is identical on every
    // run, so it can never signal change on its own; hashing it alongside the
    // bindings is what makes a tombstone-only config edit trigger an upload,
    // and it keeps the state file's shape unchanged.
    const bindingsHash = hashValue({ bindings, exports });

    const bundle = await bundleModules({
        entryFilepath: path.join(projectDirectory, 'cloudflare-server.js'),
        externals: EXTERNALS,
        fileSystem,
    });
    const { mainModule, modules } = toWorkerModules(bundle);
    const modulesHash = hashWorkerModules(modules);

    const configHash = hashValue(environmentConfig.WORKER_VERSION ?? {});

    const unprovisionedClasses = findUnprovisionedBoundClasses({
        bindings,
        liveClasses,
        provisionedClasses,
    });

    const deployment = resolveDeployment({
        deploy,
        unprovisionedClasses,
        workerIsDeployed,
        workerName,
        bindings,
    });

    const changes = {
        modules: !state || state.modulesHash !== modulesHash,
        bindings: !state || state.bindingsHash !== bindingsHash,
        config: !state || state.configHash !== configHash,
    };

    // The state file is scoped by environment, not Worker name, so a retarget
    // (WORKER.name pointed at a different Worker) leaves the recorded hashes
    // describing a Worker that is no longer the one being uploaded to.
    const retargetedFrom = state && state.workerName !== workerName ? state.workerName : null;

    // A required deployment has not happened yet, by definition: the namespace
    // is missing. Skipping the upload as unchanged would leave the class
    // unprovisioned forever, so it overrides the hash comparison. An explicit
    // --deploy is an external state change local hashes cannot represent, and
    // a retarget means the hashes describe a different Worker entirely.
    const shouldUpload = force || !state || changes.modules || changes.bindings || changes.config ||
        unprovisionedClasses.length > 0 || retargetedFrom !== null || deploy;

    if (!shouldUpload) {
        return {
            outcome: 'skipped',
            environment,
            workerName,
            stateFilepath,
            resolvedResources: [],
            changes,
            moduleCount: modules.length,
            buildId: null,
            versionId: null,
            deployed: false,
            retargetedFrom: null,
            forcedDeploymentClasses: null,
            reconciliation: null,
        };
    }

    const currentDate = now();
    const buildId = formatBuildId(currentDate);

    const version = new CloudflareWorkerVersion({
        ...(environmentConfig.WORKER_VERSION ?? {}),
        annotations: {
            'workers/tag': buildId,
            'workers/triggered_by': TRIGGERED_BY,
        },
    });

    for (const mod of modules) {
        version.addModule({ name: mod.name, content: mod.content, main: mod.name === mainModule });
    }

    for (const binding of bindings) {
        version.addBinding(binding);
    }

    version.addBinding({ type: 'plain_text', name: 'BUILD_ID', text: buildId });

    for (const [ className, entry ] of Object.entries(exports)) {
        version.addExport(className, entry);
    }

    const result = await apiClient.createWorkerVersion(
        workerName,
        version.toJSON(),
        { deploy: deployment.deploy },
    );

    const nextState = {
        workerName,
        buildId,
        versionId: result.id,
        createdAt: currentDate.toISOString(),
        deployed: deployment.deploy,
        modulesHash,
        bindingsHash,
        configHash,
    };

    await writeWorkerVersionState({ projectDirectory, environment, state: nextState, fileSystem });

    return {
        outcome: 'created',
        environment,
        workerName,
        stateFilepath,
        resolvedResources: [],
        changes,
        moduleCount: modules.length,
        buildId,
        versionId: result.id,
        deployed: deployment.deploy,
        retargetedFrom,
        forcedDeploymentClasses: deployment.forced ? unprovisionedClasses : null,
        reconciliation: result.exports_reconciliation ?? null,
    };
}

function assertKnownWorkerVersionKeys(workerVersion, environment) {
    for (const key of Object.keys(workerVersion ?? {})) {
        if (!WORKER_VERSION_KEYS.includes(key)) {
            throw new UsageError(
                `Unsupported configuration: environments.${ environment }.WORKER_VERSION.${ key }. ` +
                `Supported keys are: ${ WORKER_VERSION_KEYS.join(', ') }.`,
            );
        }
    }
}

async function fetchWorker(apiClient, workerName, environment) {
    try {
        return await apiClient.getWorker(workerName);
    } catch (error) {
        if (error.status === 404) {
            throw new UsageError(
                `Worker "${ workerName }" does not exist. Run ` +
                `\`kixx.js cloudflare create-worker -e ${ environment }\` first.`,
                { cause: error },
            );
        }

        throw error;
    }
}

/**
 * The Durable Object classes this version binds that Cloudflare has not yet
 * provisioned a namespace for. This is the whole condition that requires a
 * deployment, and it is computable before the upload.
 *
 * A binding on a class the exports map does not keep live is left alone here:
 * Cloudflare rejects it on its own terms, and guessing at it would only replace
 * a precise server-side message with a vaguer local one.
 */
function findUnprovisionedBoundClasses(args) {
    const { bindings, liveClasses, provisionedClasses } = args;

    const classNames = bindings
        .filter((binding) => binding.type === 'durable_object_namespace')
        .map((binding) => binding.class_name)
        .filter((className) => {
            return liveClasses.includes(className) && !provisionedClasses.includes(className);
        });

    return Array.from(new Set(classNames)).sort();
}

/**
 * Decides whether this upload deploys.
 *
 * Cloudflare reconciles the exports map before it validates bindings, but only
 * within a deploying upload. A version that both introduces a Durable Object
 * class and binds it therefore succeeds when deployed and is rejected when not.
 *
 * Deploying routes 100% of traffic to the new version. On a Worker that has
 * never served traffic that displaces nothing, so the command deploys on its
 * own and reports it. On a live Worker it is a production event, and belongs to
 * the developer.
 */
function resolveDeployment(args) {
    const { deploy, unprovisionedClasses, workerIsDeployed, workerName, bindings } = args;

    if (deploy) {
        return { deploy: true, forced: false };
    }

    if (unprovisionedClasses.length === 0) {
        return { deploy: false, forced: false };
    }

    if (!workerIsDeployed) {
        return { deploy: true, forced: true };
    }

    const className = unprovisionedClasses[0];
    const binding = bindings.find((entry) => {
        return entry.type === 'durable_object_namespace' && entry.class_name === className;
    });

    throw new UsageError(
        `Version would bind "${ binding.name }" to Durable Object class "${ className }", which has no ` +
        `namespace on Worker "${ workerName }" yet. Cloudflare only provisions a namespace when the version ` +
        'declaring it is deployed, so this version must be deployed to be accepted.\n' +
        `Worker "${ workerName }" is already serving traffic and deploying routes all of it to the new ` +
        'version, so re-run with --deploy to confirm that.',
    );
}
