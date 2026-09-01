import {
    BuildNotFoundError,
    BuildPointerConflictError,
} from './publishing-api-error.js';

/**
 * Assigns a Release using the build pointer state read immediately before it.
 * @param {Object} args - Assignment inputs
 * @param {Object} args.client - Publishing API client
 * @param {string} args.buildId - Build pointer id
 * @param {string} args.releaseId - Release to assign
 * @param {string} [args.reason=publish] - Assignment audit reason
 * @returns {Promise<Object>} Resulting build pointer record including its ETag
 * @throws {BuildPointerConflictError} When the pointer changes during assignment
 */
export default async function assignRelease(args) {
    const {
        client,
        buildId,
        releaseId,
        reason = 'publish',
    } = args ?? {};

    let precondition;

    try {
        const build = await client.getBuild(buildId);
        precondition = { ifMatch: build.etag };
    } catch (error) {
        if (!(error instanceof BuildNotFoundError)) {
            throw error;
        }

        precondition = { ifNoneMatch: '*' };
    }

    return await assignWithConflictContext({
        client,
        buildId,
        releaseId,
        reason,
        precondition,
    });
}

/**
 * Assigns a Release only when the build has never had a pointer.
 * @param {Object} args - Assignment inputs
 * @param {Object} args.client - Publishing API client
 * @param {string} args.buildId - Build pointer id
 * @param {string} args.releaseId - Release to assign
 * @param {string} [args.reason=publish] - Assignment audit reason
 * @returns {Promise<Object>} Resulting build pointer record including its ETag
 * @throws {BuildPointerConflictError} When the build already has a pointer
 */
export async function assignReleaseToNewBuild(args) {
    const {
        client,
        buildId,
        releaseId,
        reason = 'publish',
    } = args ?? {};

    return await assignWithConflictContext({
        client,
        buildId,
        releaseId,
        reason,
        precondition: { ifNoneMatch: '*' },
    });
}

async function assignWithConflictContext(args) {
    const {
        client,
        buildId,
        releaseId,
        reason,
        precondition,
    } = args;

    try {
        return await client.assignBuild(buildId, releaseId, {
            ...precondition,
            reason,
        });
    } catch (error) {
        if (!(error instanceof BuildPointerConflictError)) {
            throw error;
        }

        throw new BuildPointerConflictError(
            `Build pointer conflict for "${ buildId }": another operation moved or created ` +
            'the pointer concurrently. Refusing a blind retry because it would overwrite ' +
            'that change.',
            {
                status: error.status,
                errors: error.errors,
                method: error.method,
                url: error.url,
                attempts: error.attempts,
                cause: error,
            },
        );
    }
}
