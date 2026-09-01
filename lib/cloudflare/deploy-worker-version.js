import { isNonEmptyString, isPlainObject } from 'kixx-assert';
import defaultFileSystem from '../file-system.js';
import UsageError from '../usage-error.js';
import { readWorkerVersionState } from './worker-version-state.js';

/**
 * Deploys an existing Worker version to all traffic after verifying that its
 * `BUILD_ID` passes an optional caller-owned pre-deploy assertion.
 * @module deploy-worker-version
 */

/**
 * @typedef {Object} WorkerDeploymentResult
 * @property {string} environment - Deployed application environment.
 * @property {string} workerName - Cloudflare Worker receiving traffic.
 * @property {string} versionId - Version routed to all traffic.
 * @property {string} buildId - `BUILD_ID` read from the Cloudflare version.
 * @property {boolean} forced - Whether the local content guard was overridden.
 * @property {Object} deployment - Cloudflare deployment response.
 */

/**
 * @param {Object} args - Deployment options.
 * @param {string} args.projectDirectory - Absolute project root.
 * @param {string} args.environment - Cloudflare environment name.
 * @param {Object} args.cloudflareConfig - Project Cloudflare configuration.
 * @param {import('./cloudflare-api-client.js').default} args.apiClient - Cloudflare API client.
 * @param {string} [args.versionId] - Version to deploy, defaulting to recorded Worker state.
 * @param {boolean} [args.force=false] - Deploy without a local content-publish record.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @param {Function} [args.assertBuildIsPublished] - Caller-owned pre-deploy assertion
 * @returns {Promise<WorkerDeploymentResult>} Successful deployment details.
 * @throws {UsageError} When required configuration, the version, or its published content is missing.
 */
export async function deployWorkerVersion(args) {
    const {
        projectDirectory,
        environment,
        cloudflareConfig,
        apiClient,
        versionId: requestedVersionId,
        force = false,
        fileSystem = defaultFileSystem,
        assertBuildIsPublished,
    } = args ?? {};

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

    const versionId = await resolveVersionId({
        requestedVersionId,
        projectDirectory,
        environment,
        fileSystem,
    });
    const version = await getVersion(apiClient, workerName, versionId);
    const buildId = readBuildId(version, workerName, versionId);
    if (assertBuildIsPublished) {
        await assertBuildIsPublished({ buildId, versionId, workerName });
    }

    const deployment = await apiClient.createDeployment(
        workerName,
        {
            strategy: 'percentage',
            versions: [
                { version_id: versionId, percentage: 100 },
            ],
        },
        { force },
    );
    return {
        environment,
        workerName,
        versionId,
        buildId,
        forced: force,
        deployment,
    };
}

async function resolveVersionId(args) {
    const {
        requestedVersionId,
        projectDirectory,
        environment,
        fileSystem,
    } = args;

    if (requestedVersionId !== undefined) {
        if (!isNonEmptyString(requestedVersionId)) {
            throw new UsageError('The version-id positional must be a non-empty string');
        }

        return requestedVersionId;
    }

    const state = await readWorkerVersionState({ projectDirectory, environment, fileSystem });

    if (!isNonEmptyString(state?.versionId)) {
        throw new UsageError(
            `No Worker version was provided or recorded in .kixx/cloudflare-state.${ environment }.json`,
        );
    }

    return state.versionId;
}

async function getVersion(apiClient, workerName, versionId) {
    try {
        return await apiClient.getWorkerVersion(workerName, versionId);
    } catch (error) {
        if (error.status === 404) {
            throw new UsageError(
                `Worker version ${ versionId } does not exist for Worker "${ workerName }": ${ error.message }`,
                { cause: error },
            );
        }

        throw error;
    }
}

function readBuildId(version, workerName, versionId) {
    const binding = Array.isArray(version?.bindings)
        ? version.bindings.find((entry) => entry?.type === 'plain_text' && entry.name === 'BUILD_ID')
        : null;

    if (!isNonEmptyString(binding?.text)) {
        throw new UsageError(
            `Worker version ${ versionId } for Worker "${ workerName }" has no plain-text BUILD_ID binding`,
        );
    }

    return binding.text;
}
