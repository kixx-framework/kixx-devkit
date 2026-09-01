import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import resolveRunningBuild from '../../../../lib/publishing/resolve-running-build.js';

describe('resolveRunningBuild()', ({ it }) => {
    it('uses an explicit build without discovery', async () => {
        let discoveryCount = 0;
        const client = {
            discover: async () => {
                discoveryCount += 1;
            },
        };

        const buildId = await resolveRunningBuild({ client, buildId: 'explicit' });

        assertEqual('explicit', buildId);
        assertEqual(0, discoveryCount);
    });

    it('uses the authenticated discovery running build', async () => {
        const client = { discover: async () => ({ runningBuildId: 'production' }) };

        const buildId = await resolveRunningBuild({ client });

        assertEqual('production', buildId);
    });

    it('rejects a server without a runtime build id', async () => {
        const client = { discover: async () => ({ runningBuildId: null }) };
        const caught = await catchAsyncError(() => resolveRunningBuild({ client }));

        assertEqual('UsageError', caught.name);
        assertMatches('no runtime build id', caught.message);
        assertMatches('--build-id', caught.message);
    });
});

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }

    throw new Error('Expected an error');
}
