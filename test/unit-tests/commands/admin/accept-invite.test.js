import process from 'node:process';
import { assert, assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AdminAcceptInviteCommand from '../../../../commands/admin/accept-invite.js';
import { InvalidInviteError } from '../../../../lib/admin/admin-api-error.js';

describe('AdminAcceptInviteCommand', ({ it }) => {
    it('creates the account and prints its id, email, and creation date', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const received = {};
        const command = makeCommand({
            answers: {
                'Invite token': 'invite-secret',
                'New admin email address': 'new-admin@example.test',
            },
            twiceAnswer: 'a-strong-password-16plus',
            client: {
                acceptInvite: async (inviteToken, account) => {
                    received.inviteToken = inviteToken;
                    received.account = account;
                    return {
                        adminUserId: 'admin-id',
                        emailAddress: account.emailAddress,
                        userCreationDate: '2026-08-27T12:00:00.000Z',
                    };
                },
            },
        });

        const code = await command.run({ environment: 'production' });

        assertEqual(0, code);
        assertEqual('invite-secret', received.inviteToken);
        assertEqual('new-admin@example.test', received.account.emailAddress);
        assertEqual('a-strong-password-16plus', received.account.password);
        assertMatches('admin-id', stdout.mock.getCall(0).arguments[0]);
        assertMatches('new-admin@example.test', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('fails locally when the password is shorter than 16 characters, sending no request', async () => {
        let called = false;
        const command = makeCommand({
            answers: {
                'Invite token': 'invite-secret',
                'New admin email address': 'new-admin@example.test',
            },
            twiceAnswer: 'short',
            client: {
                acceptInvite: async () => {
                    called = true;
                },
            },
        });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertEqual(false, called);
    });

    it('renders operator guidance for an InvalidInviteError', async () => {
        const command = makeCommand({
            answers: {
                'Invite token': 'invite-secret',
                'New admin email address': 'new-admin@example.test',
            },
            twiceAnswer: 'a-strong-password-16plus',
            client: {
                acceptInvite: async () => {
                    throw new InvalidInviteError('rejected', {
                        status: 403, method: 'POST', url: 'https://x', attempts: 1,
                    });
                },
            },
        });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertMatches('expired', caught.message);
    });

    it('throws a UsageError naming the environment variable when stdin is not a TTY', async () => {
        delete process.env.KIXX_ADMIN_INVITE_TOKEN;
        const command = new AdminAcceptInviteCommand({ config: {} });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertMatches('KIXX_ADMIN_INVITE_TOKEN', caught.message);
    });
});

function makeCommand(args) {
    const { answers, twiceAnswer, client } = args;

    return new AdminAcceptInviteCommand({
        config: { app: { environments: { production: { origin: 'https://admin.example.test' } } } },
        createClient: () => client,
        promptForValue: async (options) => answers[options.label],
        promptForValueTwice: async () => twiceAnswer,
    });
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
