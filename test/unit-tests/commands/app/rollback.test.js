import process from 'node:process';
import { assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AppRollbackCommand from '../../../../commands/app/rollback.js';

describe('AppRollbackCommand', ({ it }) => {
    it('lists Releases and activations without assignment', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let assigned = false;
        const command = makeCommand({
            assign: async () => {
                assigned = true;
            },
        });

        await command.run({ environment: 'production', 'build-id': 'build-id', list: true });

        assertEqual(false, assigned);
        assertMatches('release-old', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('assigns an exact Release with rollback reason', async () => {
        const tracker = new MockTracker();
        tracker.method(process.stdout, 'write', () => true);
        let received;
        const command = makeCommand({
            assign: async (options) => {
                received = options;
                return { buildId: options.buildId, releaseId: options.releaseId };
            },
        });

        await command.run({
            environment: 'production',
            'build-id': 'build-id',
            'release-id': 'release-old',
        });

        assertEqual('rollback', received.reason);
        tracker.reset();
    });
});

function makeCommand(args) {
    const client = {
        listReleases: async () => ({ releases: [ { releaseId: 'release-old' } ] }),
        getBuildActivations: async () => ({
            activations: [ { releaseId: 'release-current', reason: 'publish' } ],
        }),
    };
    return new AppRollbackCommand({
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: { app: { environments: { production: { publishingToken: 'secret' } } } },
        createClient: () => client,
        assignRelease: args.assign,
    });
}
