import UsageError from '../usage-error.js';
import { BuildNotFoundError } from '../publishing/publishing-api-error.js';
import { deployWorkerVersion } from '../cloudflare/deploy-worker-version.js';

/**
 * Deploys a Cloudflare version after verifying its BUILD_ID has content.
 * @param {Object} args - Deployment and guard dependencies
 * @param {Object} args.publishingClient - Publishing API client
 * @param {boolean} [args.force=false] - Bypass the Publishing API guard
 * @param {Function} [args.deploy] - Cloudflare deployment operation
 * @returns {Promise<Object>} Cloudflare deployment result with guard status
 * @throws {UsageError} When the target build has no Publishing API pointer
 */
export default async function deployCloudflareVersion(args) {
    const {
        publishingClient,
        force = false,
        deploy = deployWorkerVersion,
        ...deploymentOptions
    } = args ?? {};

    const assertBuildIsPublished = force
        ? undefined
        : async ({ buildId, versionId }) => {
            try {
                await publishingClient.getBuild(buildId);
            } catch (error) {
                if (!(error instanceof BuildNotFoundError)) {
                    throw error;
                }

                throw new UsageError(
                    `Refusing to deploy Worker version ${ versionId } because BUILD_ID ${ buildId } ` +
                    'has no Publishing API build pointer. Assign a Release to that build first. ' +
                    'Use --force only with independent knowledge that deployment is safe.',
                    { cause: error },
                );
            }
        };

    const result = await deploy({
        ...deploymentOptions,
        force,
        assertBuildIsPublished,
    });

    return {
        ...result,
        guardBypassed: force,
    };
}
