import { assertEqual } from 'kixx-assert';
import { describe } from 'kixx-test';

import AppCreateReleaseCommand from '../../../../commands/app/create-release.js';
import captureOutput from '../../helpers/capture-output.js';

describe('AppCreateReleaseCommand', ({ it }) => {
    it('creates a Release without accepting or assigning a build', async () => {
        const output = captureOutput();
        let received;
        const command = new AppCreateReleaseCommand({
            output,
            projectDirectory: '/app',
            config: {},
            secrets: {},
            createApplicationRelease: async (options) => {
                received = options;
                return makeResult(false);
            },
        });

        await command.run({
            environment: 'production',
            message: 'ship it',
            'source-revision': 'abc123',
        });

        assertEqual(undefined, received.buildId);
        assertEqual('ship it', received.provenance.message);
        assertEqual('abc123', received.provenance.sourceRevision);
        assertEqual(true, output.chunks[0].includes('Release: release-id'));
    });

    it('dry-run prints no Release id', async () => {
        const output = captureOutput();
        const command = new AppCreateReleaseCommand({
            output,
            createApplicationRelease: async () => makeResult(true),
        });

        await command.run({ environment: 'production', 'dry-run': true });

        assertEqual(false, output.chunks[0].includes('Release:'));
    });
});

function makeResult(dryRun) {
    return {
        environment: 'production',
        origin: 'https://app.example.com',
        dryRun,
        matchedCount: 0,
        uploadedCount: 0,
        uploadedResources: [],
        unmatchedFiles: [],
        resources: [],
        releaseId: dryRun ? null : 'release-id',
        objectCount: 0,
        totalBytes: 0,
    };
}
