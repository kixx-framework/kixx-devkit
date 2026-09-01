import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import deployCloudflareVersion from '../../../../lib/release/deploy-cloudflare-version.js';
import { BuildNotFoundError } from '../../../../lib/publishing/publishing-api-error.js';

describe('deployCloudflareVersion()', ({ it }) => {
    it('verifies the target BUILD_ID before deployment', async () => {
        const calls = [];
        const publishingClient = {
            async getBuild(buildId) {
                calls.push([ 'getBuild', buildId ]);
                return { buildId, releaseId: 'release-id' };
            },
        };
        const deploy = async (options) => {
            await options.assertBuildIsPublished({
                buildId: 'build-id',
                versionId: 'version-id',
            });
            calls.push([ 'deploy' ]);
            return { buildId: 'build-id' };
        };

        const result = await deployCloudflareVersion({ publishingClient, deploy });

        assertEqual('getBuild', calls[0][0]);
        assertEqual('deploy', calls[1][0]);
        assertEqual(false, result.guardBypassed);
    });

    it('refuses a missing build pointer before deployment', async () => {
        const publishingClient = {
            async getBuild() {
                throw makeBuildNotFoundError();
            },
        };
        let deployed = false;
        const deploy = async (options) => {
            await options.assertBuildIsPublished({
                buildId: 'missing-build',
                versionId: 'version-id',
            });
            deployed = true;
        };

        const caught = await catchAsyncError(() => {
            return deployCloudflareVersion({ publishingClient, deploy });
        });

        assertEqual('UsageError', caught.name);
        assertMatches('no Publishing API build pointer', caught.message);
        assertEqual(false, deployed);
    });

    it('bypasses the guard explicitly with force', async () => {
        let checked = false;
        const publishingClient = {
            getBuild: async () => {
                checked = true;
            },
        };
        const deploy = async (options) => {
            assertEqual(undefined, options.assertBuildIsPublished);
            return { forced: options.force };
        };

        const result = await deployCloudflareVersion({
            publishingClient,
            deploy,
            force: true,
        });

        assertEqual(false, checked);
        assertEqual(true, result.forced);
        assertEqual(true, result.guardBypassed);
    });
});

function makeBuildNotFoundError() {
    return new BuildNotFoundError('not found', {
        status: 404,
        method: 'GET',
        url: 'https://example.com/builds/missing-build',
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
