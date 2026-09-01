import process from 'node:process';
import { assertEqual } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AppCreateReleaseCommand from '../../../../commands/app/create-release.js';

describe('AppCreateReleaseCommand', ({ it }) => {
    it('creates a Release without accepting or assigning a build', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let received;
        const command = new AppCreateReleaseCommand({
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
        assertEqual(true, stdout.mock.getCall(0).arguments[0].includes('Release: release-id'));
        tracker.reset();
    });

    it('dry-run prints no Release id', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const command = new AppCreateReleaseCommand({
            createApplicationRelease: async () => makeResult(true),
        });

        await command.run({ environment: 'production', 'dry-run': true });

        assertEqual(false, stdout.mock.getCall(0).arguments[0].includes('Release:'));
        tracker.reset();
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
