import process from 'node:process';
import { assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AppRollbackCommand from '../../../../commands/app/rollback.js';

const ASSIGNMENT_ID = '4a2f7b2e-6d1c-4f0a-9b83-1c5d7e9a0f21';
const FIRST_ASSIGNMENT_ID = '8f3c1d40-52ab-4e19-8d77-6b0e2a4c9153';

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

        const output = stdout.mock.getCall(0).arguments[0];
        assertEqual(false, assigned);

        // Ids print unabbreviated: an operator pastes one back into
        // --release-id straight from this listing.
        assertMatches('release-old', output);
        assertMatches('release-previous -> release-current', output);
        assertMatches(`assignment ${ ASSIGNMENT_ID }`, output);
        assertMatches('reason publish', output);
        tracker.reset();
    });

    it('renders a first assignment as having no predecessor', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const command = makeCommand({
            assign: async () => null,
            activations: [ {
                activationId: `build-id:${ FIRST_ASSIGNMENT_ID }`,
                buildId: 'build-id',
                assignmentId: FIRST_ASSIGNMENT_ID,
                fromReleaseId: null,
                toReleaseId: 'release-first',
                activatedAt: '2026-09-01T00:00:00.000Z',
                reason: 'publish',
            } ],
        });

        await command.run({ environment: 'production', 'build-id': 'build-id', list: true });

        // A null predecessor is a state, not missing data.
        assertMatches('(first assignment) -> release-first', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('explains an empty activation history instead of failing', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const command = makeCommand({ assign: async () => null, activations: [] });

        // History is best-effort upstream and a no-op assignment records
        // nothing, so an empty list is legitimate.
        const code = await command.run({
            environment: 'production',
            'build-id': 'build-id',
            list: true,
        });

        assertEqual(0, code);
        assertMatches('(none recorded)', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('assigns an exact Release with rollback reason', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let received;
        const command = makeCommand({
            assign: async (options) => {
                received = options;
                return {
                    buildId: options.buildId,
                    releaseId: options.releaseId,
                    assignmentId: ASSIGNMENT_ID,
                };
            },
        });

        await command.run({
            environment: 'production',
            'build-id': 'build-id',
            'release-id': 'release-old',
        });

        const output = stdout.mock.getCall(0).arguments[0];
        assertEqual('rollback', received.reason);
        assertMatches('Rolled back build build-id to Release release-old', output);
        assertMatches(`Assignment: ${ ASSIGNMENT_ID }`, output);
        tracker.reset();
    });
});

function makeCommand(args) {
    const { activations } = args;
    const client = {
        listReleases: async () => ({
            releases: [ { releaseId: 'release-old', createdAt: '2026-08-31T00:00:00.000Z' } ],
        }),
        getBuildActivations: async () => ({
            activations: activations ?? [ {
                activationId: `build-id:${ ASSIGNMENT_ID }`,
                buildId: 'build-id',
                assignmentId: ASSIGNMENT_ID,
                fromReleaseId: 'release-previous',
                toReleaseId: 'release-current',
                activatedAt: '2026-09-01T00:00:00.000Z',
                activatedBy: 'token-id',
                reason: 'publish',
            } ],
        }),
    };
    return new AppRollbackCommand({
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: { app: { environments: { production: { publishingToken: 'secret' } } } },
        createClient: () => client,
        assignRelease: args.assign,
    });
}
