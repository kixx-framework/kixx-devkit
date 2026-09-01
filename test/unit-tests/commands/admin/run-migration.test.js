import process from 'node:process';
import { assert, assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AdminRunMigrationCommand from '../../../../commands/admin/run-migration.js';
import {
    MigrationAlreadyAppliedError,
    MigrationCursorConflictError,
    MigrationConcurrencyError,
} from '../../../../lib/admin/admin-api-error.js';

describe('AdminRunMigrationCommand', ({ it }) => {
    it('sends exactly one real batch and prints done, status, stats, and cursor', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        let callCount = 0;
        const command = makeCommand({
            client: {
                runMigration: async () => {
                    callCount += 1;
                    return { done: true, status: 'applied', stats: { scanned: 1 }, cursor: null, dryRun: false };
                },
            },
        });

        const code = await command.run({ environment: 'production' }, 'example-noop');
        const output = stdout.mock.getCall(stdout.mock.callCount() - 1).arguments[0];

        assertEqual(0, code);
        assertEqual(1, callCount);
        assertMatches('done: true', output);
        assertMatches('status: applied', output);
        tracker.reset();
    });

    it('prints the resolved environment and origin before a real run', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const command = makeCommand({
            client: { runMigration: async () => ({ done: true, status: 'applied', stats: {}, cursor: null }) },
        });

        await command.run({ environment: 'production' }, 'example-noop');

        assertMatches('production', stdout.mock.getCall(0).arguments[0]);
        assertMatches('https://admin.example.test', stdout.mock.getCall(0).arguments[0]);
        tracker.reset();
    });

    it('does not print the target echo for a dry run and sends dryRun true', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const received = {};
        const command = makeCommand({
            client: {
                runMigration: async (_id, options) => {
                    Object.assign(received, options);
                    return { done: false, status: 'dry-run', stats: {}, cursor: 'next-cursor', dryRun: true };
                },
            },
        });

        await command.run({ environment: 'production', 'dry-run': true }, 'example-noop');

        assertEqual(true, received.dryRun);
        assertEqual(1, stdout.mock.callCount());
        tracker.reset();
    });

    it('fails with a UsageError when --dry-run and --force are both passed', async () => {
        const command = makeCommand({ client: {} });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production', 'dry-run': true, force: true }, 'example-noop');
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });

    it('fails with a UsageError when --cursor is passed without --dry-run', async () => {
        const command = makeCommand({ client: {} });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production', cursor: 'abc' }, 'example-noop');
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });

    it('prompts for a typed confirmation on --force and aborts when it does not match', async () => {
        let called = false;
        const command = makeCommand({
            client: {
                runMigration: async () => {
                    called = true;
                },
            },
            promptForConfirmation: async () => {
                throw new Error('Confirmation did not match');
            },
        });

        const caught = await catchAsyncError(() => {
            return command.run({ environment: 'production', force: true }, 'example-noop');
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual(false, called);
    });

    it('proceeds without prompting when --force and --yes are both passed', async () => {
        let confirmed = false;
        const tracker = new MockTracker();
        tracker.method(process.stdout, 'write', () => true);
        const command = makeCommand({
            client: {
                runMigration: async () => ({ done: true, status: 'applied', stats: {}, cursor: null }),
            },
            promptForConfirmation: async () => {
                confirmed = true;
            },
        });

        await command.run({ environment: 'production', force: true, yes: true }, 'example-noop');

        assertEqual(false, confirmed);
        tracker.reset();
    });

    it('states the next invocation to run when the batch is not done', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const command = makeCommand({
            client: {
                runMigration: async () => ({
                    done: false, status: 'dry-run', stats: {}, cursor: 'cursor-2', dryRun: true,
                }),
            },
        });

        await command.run({ environment: 'production', 'dry-run': true }, 'example-noop');
        const output = stdout.mock.getCall(stdout.mock.callCount() - 1).arguments[0];

        assertMatches('Next:', output);
        assertMatches('cursor-2', output);
        assertMatches('--dry-run', output);
        tracker.reset();
    });

    it('renders distinct guidance for each migration conflict error', async () => {
        const tracker = new MockTracker();
        tracker.method(process.stdout, 'write', () => true);
        const cases = [
            [ MigrationAlreadyAppliedError, '--force' ],
            [ MigrationCursorConflictError, '--force' ],
            [ MigrationConcurrencyError, 'without --force' ],
        ];

        for (const [ ErrorClass, expectedPhrase ] of cases) {
            const command = makeCommand({
                client: {
                    runMigration: async () => {
                        throw new ErrorClass('failed', {
                            status: 409, method: 'POST', url: 'https://x', attempts: 1,
                        });
                    },
                },
            });

            const caught = await catchAsyncError(() => command.run({ environment: 'production' }, 'example-noop'));

            assert(caught, `expected an error to be thrown for ${ ErrorClass.name }`);
            assertEqual('UsageError', caught.name);
            assertMatches(expectedPhrase, caught.message);
        }
        tracker.reset();
    });

    it('fails with a UsageError when the migration id argument is missing', async () => {
        const command = makeCommand({ client: {} });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });
});

function makeCommand(args) {
    const { client, promptForConfirmation } = args;

    return new AdminRunMigrationCommand({
        config: { app: { environments: { production: { origin: 'https://admin.example.test' } } } },
        createClient: () => client,
        promptForValue: async () => 'stub-value',
        promptForConfirmation,
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
