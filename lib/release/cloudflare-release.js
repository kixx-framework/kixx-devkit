import { createPreparedWorkerVersion, prepareWorkerVersion } from '../cloudflare/create-worker-version.js';
import { deployWorkerVersion } from '../cloudflare/deploy-worker-version.js';
import assignRelease, { assignReleaseToNewBuild } from '../publishing/assign-release.js';
import createApplicationRelease from '../publishing/create-application-release.js';
import resolveRunningBuild from '../publishing/resolve-running-build.js';

/**
 * Pre-stages content before creating and deploying a Cloudflare Worker version.
 * @param {Object} args - Release inputs and dependencies
 * @returns {Promise<Object>} Completed phase results
 */
export default async function releaseToCloudflare(args) {
    const {
        projectDirectory,
        environment,
        cloudflareConfig,
        config,
        secrets,
        origin,
        token,
        force = false,
        fileSystem,
        cloudflareClient,
        publishingClient,
        prepare = prepareWorkerVersion,
        createVersion = createPreparedWorkerVersion,
        createRelease = createApplicationRelease,
        assign = assignRelease,
        assignNew = assignReleaseToNewBuild,
        resolveBuild = resolveRunningBuild,
        deploy = deployWorkerVersion,
    } = args ?? {};
    const prepared = await prepare({
        projectDirectory,
        environment,
        cloudflareConfig,
        apiClient: cloudflareClient,
        force,
        allowForcedDeployment: true,
        fileSystem,
    });

    if (prepared.outcome === 'resources-resolved') {
        return { outcome: 'resources-resolved', prepared };
    }

    const buildId = prepared.outcome === 'skipped'
        ? await resolveBuild({ client: publishingClient })
        : prepared.buildId;
    let release;

    try {
        release = await createRelease({
            projectDirectory,
            environment,
            config,
            secrets,
            origin,
            token,
            provenance: { client: 'kixx-devkit', intendedForBuildId: buildId },
            fileSystem,
            createClient: () => publishingClient,
        });

        if (prepared.outcome === 'skipped') {
            await assign({ client: publishingClient, buildId, releaseId: release.releaseId });
        } else {
            await assignNew({ client: publishingClient, buildId, releaseId: release.releaseId });
            const staged = await publishingClient.getBuild(buildId);
            if (staged.releaseId !== release.releaseId) {
                throw new Error(
                    `Staged build ${ buildId } resolved to Release ${ staged.releaseId }, ` +
                    `not ${ release.releaseId }`,
                );
            }
        }
    } catch (cause) {
        throw new Error(
            `Release stopped before Worker creation for build ${ buildId }. Traffic was unchanged. ` +
            `The immutable Release or inert build pointer may remain; inspect build ${ buildId } before retrying. ` +
            cause.message,
            { cause },
        );
    }

    if (prepared.outcome === 'skipped') {
        return { outcome: 'content-only', prepared, release, buildId };
    }

    let created;
    try {
        created = await createVersion({
            projectDirectory,
            environment,
            apiClient: cloudflareClient,
            prepared,
            fileSystem,
        });
    } catch (cause) {
        throw new Error(
            `Release staged an inert pointer for build ${ buildId }, but Worker creation failed. ` +
            'Traffic was unchanged. Inspect the reported build before retrying cloudflare release. ' +
            cause.message,
            { cause },
        );
    }

    if (created.deployed) {
        return { outcome: 'released', prepared, release, created, deployment: null, buildId };
    }

    try {
        const deployment = await deploy({
            projectDirectory,
            environment,
            cloudflareConfig,
            apiClient: cloudflareClient,
            versionId: created.versionId,
            fileSystem,
        });
        return { outcome: 'released', prepared, release, created, deployment, buildId };
    } catch (cause) {
        throw new Error(
            `Release staged build ${ buildId } and created Worker version ${ created.versionId }, but deployment ` +
            `failed. Run cloudflare deploy-version ${ created.versionId } --environment ${ environment }. ` +
            cause.message,
            { cause },
        );
    }
}
