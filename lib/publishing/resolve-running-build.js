import { isNonEmptyString, isUndefined } from 'kixx-assert';

import UsageError from '../usage-error.js';

/**
 * Resolves an explicit build id or the server's authenticated running build.
 * @param {Object} args - Resolution inputs
 * @param {Object} args.client - Publishing API client
 * @param {string} [args.buildId] - Explicit build id
 * @returns {Promise<string>} Build id to publish or assign
 * @throws {UsageError} When neither source identifies a runtime build
 */
export default async function resolveRunningBuild(args) {
    const { client, buildId } = args ?? {};

    if (!isUndefined(buildId)) {
        if (!isNonEmptyString(buildId)) {
            throw new UsageError('The --build-id option must be a non-empty string');
        }

        return buildId;
    }

    const capabilities = await client.discover();
    if (!isNonEmptyString(capabilities.runningBuildId)) {
        throw new UsageError(
            'The target server has no runtime build id. Pass --build-id <id> to name a build ' +
            'explicitly, or use app assign-build after creating a Release.',
        );
    }

    return capabilities.runningBuildId;
}
