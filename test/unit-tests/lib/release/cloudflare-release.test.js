import { assertEqual } from 'kixx-assert';
import { describe } from 'kixx-test';
import releaseToCloudflare from '../../../../lib/release/cloudflare-release.js';

const ASSIGNMENT_ID = '4a2f7b2e-6d1c-4f0a-9b83-1c5d7e9a0f21';

describe('cloudflare-release', ({ it }) => {
    it('stages and verifies content before creating a version', async () => {
        const calls = [];
        const result = await releaseToCloudflare(makeOptions({ calls }));

        assertEqual('release,assign-new,get-build,create,deploy', calls.join(','));
        assertEqual('released', result.outcome);
    });

    it('uses the discovered running build for a content-only release', async () => {
        const calls = [];
        const result = await releaseToCloudflare(makeOptions({ calls, outcome: 'skipped' }));

        assertEqual('resolve,release,assign', calls.join(','));
        assertEqual('content-only', result.outcome);
        assertEqual('running-build', result.buildId);
    });

    it('stops after resource resolution', async () => {
        const calls = [];
        const result = await releaseToCloudflare(makeOptions({ calls, outcome: 'resources-resolved' }));

        assertEqual('', calls.join(','));
        assertEqual('resources-resolved', result.outcome);
    });

    it('allows forced deployment only after staging verification', async () => {
        const calls = [];
        const result = await releaseToCloudflare(makeOptions({ calls, deployOnCreate: true }));

        assertEqual('release,assign-new,get-build,create', calls.join(','));
        assertEqual(true, result.created.deployed);
    });

    it('stops when the staged pointer holds a different Release', async () => {
        const calls = [];
        const options = makeOptions({ calls, stagedReleaseId: 'someone-elses-release' });
        const caught = await catchAsyncError(() => releaseToCloudflare(options));

        assertEqual('release,assign-new,get-build', calls.join(','));
        assertEqual(true, caught.message.includes('someone-elses-release'));
        assertEqual(true, caught.message.includes('Traffic was unchanged'));
    });

    it('stops when the staged pointer holds a different assignment identity', async () => {
        const calls = [];
        const options = makeOptions({
            calls,
            stagedAssignmentId: '8f3c1d40-52ab-4e19-8d77-6b0e2a4c9153',
        });

        // Same Release, different act. Only the identity distinguishes a
        // concurrent write that happened to land on the same Release.
        const caught = await catchAsyncError(() => releaseToCloudflare(options));

        assertEqual('release,assign-new,get-build', calls.join(','));
        assertEqual(true, caught.message.includes('reassigned the pointer'));
        assertEqual(true, caught.message.includes('Traffic was unchanged'));
    });

    it('does not create a version when first assignment collides', async () => {
        const calls = [];
        const options = makeOptions({ calls });
        options.assignNew = async () => {
            calls.push('assign-new');
            throw new Error('pointer conflict');
        };
        let caught;
        try {
            await releaseToCloudflare(options);
        } catch (error) {
            caught = error;
        }

        assertEqual('release,assign-new', calls.join(','));
        assertEqual(true, caught.message.includes('Traffic was unchanged'));
    });
});

function makeOptions(args) {
    const {
        calls,
        outcome = 'prepared',
        deployOnCreate = false,
        stagedReleaseId = 'release-id',
        stagedAssignmentId = ASSIGNMENT_ID,
    } = args;
    const prepared = {
        outcome,
        buildId: outcome === 'prepared' ? 'future-build' : null,
        workerName: 'worker',
        deployOnCreate,
    };
    return {
        projectDirectory: '/app',
        environment: 'production',
        cloudflareClient: {},
        publishingClient: {
            async getBuild() {
                calls.push('get-build');
                return { releaseId: stagedReleaseId, assignmentId: stagedAssignmentId };
            },
        },
        prepare: async () => prepared,
        resolveBuild: async () => {
            calls.push('resolve');
            return 'running-build';
        },
        createRelease: async (options) => {
            calls.push('release');
            assertEqual(options.provenance.intendedForBuildId, outcome === 'prepared' ? 'future-build' : 'running-build');
            return { releaseId: 'release-id' };
        },
        assignNew: async () => {
            calls.push('assign-new');
            return { buildId: 'future-build', releaseId: 'release-id', assignmentId: ASSIGNMENT_ID };
        },
        assign: async () => {
            calls.push('assign');
            return { buildId: 'running-build', releaseId: 'release-id', assignmentId: ASSIGNMENT_ID };
        },
        createVersion: async () => {
            calls.push('create');
            return { ...prepared, outcome: 'created', versionId: 'version-id', deployed: deployOnCreate };
        },
        deploy: async () => {
            calls.push('deploy');
            return { versionId: 'version-id' };
        },
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    throw new Error('Expected an error');
}
