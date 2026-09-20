import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import AppRollbackCommand from '../../../../commands/app/rollback.js';
import captureOutput from '../../helpers/capture-output.js';

const ASSIGNMENT_ID = '4a2f7b2e-6d1c-4f0a-9b83-1c5d7e9a0f21';
const FIRST_ASSIGNMENT_ID = '8f3c1d40-52ab-4e19-8d77-6b0e2a4c9153';

describe('AppRollbackCommand', ({ it }) => {
    it('lists Releases and activations without assignment', async () => {
        const output = captureOutput();
        let assigned = false;
        const command = makeCommand({
            output,
            assign: async () => {
                assigned = true;
            },
        });

        await command.run({ environment: 'production', 'build-id': 'build-id', list: true });

        const text = output.chunks[0];
        assertEqual(false, assigned);

        // Ids print unabbreviated: an operator pastes one back into
        // --release-id straight from this listing.
        assertMatches('release-old', text);
        assertMatches('release-previous -> release-current', text);
        assertMatches(`assignment ${ ASSIGNMENT_ID }`, text);
        assertMatches('reason publish', text);
    });

    it('renders a first assignment as having no predecessor', async () => {
        const output = captureOutput();
        const command = makeCommand({
            output,
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
        assertMatches('(first assignment) -> release-first', output.chunks[0]);
    });

    it('explains an empty activation history instead of failing', async () => {
        const output = captureOutput();
        const command = makeCommand({ output, assign: async () => null, activations: [] });

        // History is best-effort upstream and a no-op assignment records
        // nothing, so an empty list is legitimate.
        const code = await command.run({
            environment: 'production',
            'build-id': 'build-id',
            list: true,
        });

        assertEqual(0, code);
        assertMatches('(none recorded)', output.chunks[0]);
    });

    it('assigns an exact Release with rollback reason', async () => {
        const output = captureOutput();
        let received;
        const command = makeCommand({
            output,
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

        const text = output.chunks[0];
        assertEqual('rollback', received.reason);
        assertMatches('Rolled back build build-id to Release release-old', text);
        assertMatches(`Assignment: ${ ASSIGNMENT_ID }`, text);
    });
});

function makeCommand(args) {
    const { activations, output = captureOutput() } = args;
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
        output,
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: { app: { environments: { production: { publishingToken: 'secret' } } } },
        createClient: () => client,
        assignRelease: args.assign,
    });
}
