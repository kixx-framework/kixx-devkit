import path from 'node:path';
import { isNonEmptyString } from 'kixx-assert';
import UsageError from '../usage-error.js';
import defaultFileSystem from '../file-system.js';
import defaultBundleModules from '../bundler/bundle-modules.js';
import { hashValue } from '../canonical-hash.js';
import { readEnvFile } from '../env-file.js';
import CloudflareWorkerVersion from './cloudflare-worker-version.js';
import { getStateFilepath, readWorkerVersionState, writeWorkerVersionState } from './worker-version-state.js';
import { toWorkerModules, hashWorkerModules } from './worker-modules.js';
import { buildWorkerBindings } from './worker-bindings.js';
import { planDurableObjectMigrations } from './durable-object-migrations.js';
import { resolveResources } from './provision-resources.js';
import { formatBuildId } from './build-id.js';

const EXTERNALS = [ 'node:', 'cloudflare:' ];
const TRIGGERED_BY = 'kixx.js cloudflare create-worker-version';

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
 * @property {Object|null} migrations - `{ operations, oldTag, newTag }` when a migration was applied, otherwise `null`.
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
 *     exist, or Cloudflare rejects a migration's tag.
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

    const workerName = environmentConfig.WORKER.name;
    const stateFilepath = getStateFilepath({ projectDirectory, environment });

    await assertWorkerExists(apiClient, workerName, environment);

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
            migrations: null,
        };
    }

    const secrets = await readEnvFile({ projectDirectory, environment, fileSystem });
    const state = await readWorkerVersionState({ projectDirectory, environment, fileSystem });

    const bindings = buildWorkerBindings({ environmentConfig, secrets });
    const bindingsHash = hashValue(bindings);

    const bundle = await bundleModules({
        entryFilepath: path.join(projectDirectory, 'cloudflare-server.js'),
        externals: EXTERNALS,
        fileSystem,
    });
    const { mainModule, modules } = toWorkerModules(bundle);
    const modulesHash = hashWorkerModules(modules);

    const configHash = hashValue(environmentConfig.WORKER_VERSION ?? {});

    const migrationPlan = planDurableObjectMigrations({
        environmentConfig,
        recordedClasses: state?.durableObjectClasses ?? [],
        migrationTag: state?.migrationTag ?? null,
    });

    const changes = {
        modules: !state || state.modulesHash !== modulesHash,
        bindings: !state || state.bindingsHash !== bindingsHash,
        config: !state || state.configHash !== configHash,
    };

    const shouldUpload = force || !state || changes.modules || changes.bindings || changes.config ||
        migrationPlan.operations !== null;

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
            migrations: null,
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

    if (migrationPlan.operations) {
        applyMigrationOperations(version, migrationPlan);
    }

    let result;
    try {
        result = await apiClient.createWorkerVersion(workerName, version.toJSON(), { deploy });
    } catch (error) {
        if (migrationPlan.operations && isStaleMigrationTagError(error)) {
            throw new UsageError(
                `Cloudflare rejected migration tag "${ migrationPlan.oldTag }"; the Worker's tag has already ` +
                `moved past it, most likely from a crash after a prior successful upload. Record ` +
                `migrationTag "${ migrationPlan.newTag }" in ${ stateFilepath } by hand and verify the Worker's ` +
                'actual Durable Object classes before re-running.',
                { cause: error },
            );
        }

        throw error;
    }

    const nextState = {
        workerName,
        buildId,
        versionId: result.id,
        createdAt: currentDate.toISOString(),
        deployed: deploy,
        modulesHash,
        bindingsHash,
        configHash,
        migrationTag: migrationPlan.operations ? migrationPlan.newTag : (state?.migrationTag ?? null),
        durableObjectClasses: migrationPlan.nextClasses,
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
        deployed: deploy,
        migrations: migrationPlan.operations
            ? { operations: migrationPlan.operations, oldTag: migrationPlan.oldTag, newTag: migrationPlan.newTag }
            : null,
    };
}

async function assertWorkerExists(apiClient, workerName, environment) {
    try {
        await apiClient.getWorker(workerName);
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

function applyMigrationOperations(version, migrationPlan) {
    const { operations, oldTag, newTag } = migrationPlan;

    (operations.new_sqlite_classes ?? []).forEach((className) => version.addNewSqliteClass(className));
    (operations.deleted_classes ?? []).forEach((className) => version.deleteClass(className));
    (operations.renamed_classes ?? []).forEach(({ from, to }) => version.renameClass(from, to));
    (operations.transferred_classes ?? []).forEach((transfer) => version.transferClass(transfer));

    version.setMigrationTags(oldTag, newTag);
}

// The exact shape Cloudflare uses to reject a stale old_tag is not yet known
// (see this plan's Task 12 open question); this matches conservatively on a
// Cloudflare error entry mentioning "tag" so an unrelated failure during a
// migrated upload is never misreported as a tag drift.
function isStaleMigrationTagError(error) {
    return error?.name === 'CloudflareApiError' &&
        Array.isArray(error.errors) &&
        error.errors.some((entry) => typeof entry.message === 'string' && /tag/i.test(entry.message));
}
