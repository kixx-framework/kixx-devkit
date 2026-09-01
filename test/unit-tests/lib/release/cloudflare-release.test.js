import { assertEqual } from 'kixx-assert';
import { describe } from 'kixx-test';
import releaseToCloudflare from '../../../../lib/release/cloudflare-release.js';

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
    const { calls, outcome = 'prepared', deployOnCreate = false } = args;
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
                return { releaseId: 'release-id' };
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
        assignNew: async () => calls.push('assign-new'),
        assign: async () => calls.push('assign'),
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
