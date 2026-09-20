import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import AppAssignBuildCommand from '../../../../commands/app/assign-build.js';
import captureOutput from '../../helpers/capture-output.js';

const ASSIGNMENT_ID = '4a2f7b2e-6d1c-4f0a-9b83-1c5d7e9a0f21';

describe('AppAssignBuildCommand', ({ it }) => {
    it('only delegates pointer assignment with the requested reason', async () => {
        const output = captureOutput();
        let received;
        const command = makeCommand(output, async (options) => {
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
        assertMatches(`Assignment:  ${ ASSIGNMENT_ID }`, output.chunks[0]);
    });
});

function makeCommand(output, assign) {
    return new AppAssignBuildCommand({
        output,
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: { app: { environments: { production: { publishingToken: 'secret' } } } },
        createClient: () => ({}),
        assignRelease: assign,
    });
}
