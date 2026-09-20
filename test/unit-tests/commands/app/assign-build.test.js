import process from 'node:process';
import { assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AppAssignBuildCommand from '../../../../commands/app/assign-build.js';

const ASSIGNMENT_ID = '4a2f7b2e-6d1c-4f0a-9b83-1c5d7e9a0f21';

describe('AppAssignBuildCommand', ({ it }) => {
    it('only delegates pointer assignment with the requested reason', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let received;
        const command = makeCommand(async (options) => {
            received = options;
            return {
                buildId: options.buildId,
                releaseId: options.releaseId,
                assignmentId: ASSIGNMENT_ID,
            };
        });

        await command.run({
            environment: 'production',
            'build-id': 'build-id',
            'release-id': 'release-id',
            reason: 'restore',
        });

        assertEqual('build-id', received.buildId);
        assertEqual('release-id', received.releaseId);
        assertEqual('restore', received.reason);

        // The resulting identity is what the next write must quote, and the
        // only handle correlating this run with activation history.
        assertMatches(`Assignment:  ${ ASSIGNMENT_ID }`, stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });
});

function makeCommand(assign) {
    return new AppAssignBuildCommand({
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: { app: { environments: { production: { publishingToken: 'secret' } } } },
        createClient: () => ({}),
        assignRelease: assign,
    });
}
