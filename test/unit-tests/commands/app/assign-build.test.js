import process from 'node:process';
import { assertEqual } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AppAssignBuildCommand from '../../../../commands/app/assign-build.js';

describe('AppAssignBuildCommand', ({ it }) => {
    it('only delegates pointer assignment with the requested reason', async () => {
        const tracker = new MockTracker();
        tracker.method(process.stdout, 'write', () => true);
        let received;
        const command = makeCommand(async (options) => {
            received = options;
            return { buildId: options.buildId, releaseId: options.releaseId };
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
