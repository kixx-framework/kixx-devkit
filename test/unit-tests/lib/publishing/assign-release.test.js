import { assertEqual, assertMatches, assertUndefined } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import assignRelease, {
    assignReleaseToNewBuild,
} from '../../../../lib/publishing/assign-release.js';
import {
    BuildNotFoundError,
    BuildPointerConflictError,
} from '../../../../lib/publishing/publishing-api-error.js';

describe('assignRelease()', ({ it }) => {
    it('uses If-None-Match when the build is unassigned', async () => {
        const tracker = new MockTracker();
        const client = makeClient(tracker);
        client.getBuild.mock.mockImplementation(async () => {
            throw makeApiError(BuildNotFoundError, 404);
        });

        const result = await assignRelease({
            client,
            buildId: 'new-build',
            releaseId: 'release-id',
            reason: 'carry-forward',
        });

        assertEqual('release-id', result.releaseId);
        assertEqual(1, client.getBuild.mock.callCount());
        assertEqual(1, client.assignBuild.mock.callCount());
        const call = client.assignBuild.mock.getCall(0);
        assertEqual('new-build', call.arguments[0]);
        assertEqual('release-id', call.arguments[1]);
        assertEqual(true, call.arguments[2].expectUnassigned);
        assertEqual('carry-forward', call.arguments[2].reason);
        tracker.reset();
    });

    it('uses the current release id when the build is assigned', async () => {
        const tracker = new MockTracker();
        const client = makeClient(tracker, {
            buildId: 'production',
            releaseId: 'old-release',
        });

        await assignRelease({
            client,
            buildId: 'production',
            releaseId: 'new-release',
            reason: 'rollback',
        });

        const call = client.assignBuild.mock.getCall(0);
        assertEqual('production', call.arguments[0]);
        assertEqual('new-release', call.arguments[1]);
        assertEqual('old-release', call.arguments[2].expectedReleaseId);
        assertUndefined(call.arguments[2].expectUnassigned);
        assertEqual('rollback', call.arguments[2].reason);
        tracker.reset();
    });

    it('ignores a weak or missing ETag header on the build read', async () => {
        for (const etag of [ 'W/"old-release"', null, undefined ]) {
            const tracker = new MockTracker();
            const client = makeClient(tracker, {
                buildId: 'production',
                releaseId: 'old-release',
                etag,
            });

            await assignRelease({
                client,
                buildId: 'production',
                releaseId: 'new-release',
            });

            const call = client.assignBuild.mock.getCall(0);
            assertEqual('old-release', call.arguments[2].expectedReleaseId);
            tracker.reset();
        }
    });

    it('treats assigning the current Release as ordinary success', async () => {
        const tracker = new MockTracker();
        const client = makeClient(tracker, {
            buildId: 'production',
            releaseId: 'same-release',
        });

        const result = await assignRelease({
            client,
            buildId: 'production',
            releaseId: 'same-release',
        });

        assertEqual('same-release', result.releaseId);
        assertEqual(1, client.assignBuild.mock.callCount());
        tracker.reset();
    });

    it('surfaces a concurrent pointer move without retrying', async () => {
        const tracker = new MockTracker();
        const client = makeClient(tracker);
        client.assignBuild.mock.mockImplementation(async () => {
            throw makeApiError(BuildPointerConflictError, 412);
        });

        const caught = await catchAsyncError(() => assignRelease({
            client,
            buildId: 'production',
            releaseId: 'release-id',
        }));

        assertEqual('BuildPointerConflictError', caught.name);
        assertEqual(412, caught.status);
        assertMatches('another operation moved or created', caught.message);
        assertMatches('blind retry', caught.message);
        assertEqual(1, client.assignBuild.mock.callCount());
        tracker.reset();
    });

    it('assigns a new build without reading or conflict fallback', async () => {
        const tracker = new MockTracker();
        const client = makeClient(tracker);
        client.assignBuild.mock.mockImplementation(async () => {
            throw makeApiError(BuildPointerConflictError, 412);
        });

        const caught = await catchAsyncError(() => assignReleaseToNewBuild({
            client,
            buildId: 'future-build',
            releaseId: 'release-id',
            reason: 'restore',
        }));

        assertEqual('BuildPointerConflictError', caught.name);
        assertEqual(0, client.getBuild.mock.callCount());
        assertEqual(1, client.assignBuild.mock.callCount());
        const call = client.assignBuild.mock.getCall(0);
        assertEqual('future-build', call.arguments[0]);
        assertEqual('release-id', call.arguments[1]);
        assertEqual(true, call.arguments[2].expectUnassigned);
        assertEqual('restore', call.arguments[2].reason);
        tracker.reset();
    });
});

function makeClient(tracker, build) {
    const currentBuild = build ?? {
        buildId: 'production',
        releaseId: 'old-release',
    };

    return {
        getBuild: tracker.fn(async () => currentBuild),
        assignBuild: tracker.fn(async (buildId, releaseId) => ({
            buildId,
            releaseId,
        })),
    };
}

function makeApiError(ErrorClass, status) {
    return new ErrorClass('API failure', {
        status,
        errors: [],
        method: 'PUT',
        url: 'https://example.com/publishing-api/v1/builds/production',
        attempts: 1,
    });
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }

    throw new Error('Expected an error');
}
