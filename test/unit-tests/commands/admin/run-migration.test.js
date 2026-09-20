import { assert, assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import AdminRunMigrationCommand from '../../../../commands/admin/run-migration.js';
import captureOutput from '../../helpers/capture-output.js';
import {
    MigrationAlreadyAppliedError,
    MigrationCursorConflictError,
    MigrationConcurrencyError,
} from '../../../../lib/admin/admin-api-error.js';

describe('AdminRunMigrationCommand', ({ it }) => {
    it('sends exactly one real batch and prints done, status, stats, and cursor', async () => {
        const output = captureOutput();
        let callCount = 0;
        const command = makeCommand({
            output,
            client: {
                runMigration: async () => {
                    callCount += 1;
                    return { done: true, status: 'applied', stats: { scanned: 1 }, cursor: null, dryRun: false };
                },
            },
        });

        const code = await command.run({ environment: 'production' }, 'example-noop');
        const text = output.chunks.at(-1);

        assertEqual(0, code);
        assertEqual(1, callCount);
        assertMatches('done: true', text);
        assertMatches('status: applied', text);
    });

    it('prints the resolved environment and origin before a real run', async () => {
        const output = captureOutput();
        const command = makeCommand({
            output,
            client: { runMigration: async () => ({ done: true, status: 'applied', stats: {}, cursor: null }) },
        });

        await command.run({ environment: 'production' }, 'example-noop');

        assertMatches('production', output.chunks[0]);
        assertMatches('https://admin.example.test', output.chunks[0]);
    });

    it('does not print the target echo for a dry run and sends dryRun true', async () => {
        const output = captureOutput();
        const received = {};
        const command = makeCommand({
            output,
            client: {
                runMigration: async (_id, options) => {
                    Object.assign(received, options);
                    return { done: false, status: 'dry-run', stats: {}, cursor: 'next-cursor', dryRun: true };
                },
            },
        });

        await command.run({ environment: 'production', 'dry-run': true }, 'example-noop');

        assertEqual(true, received.dryRun);
        assertEqual(1, output.chunks.length);
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
    });

    it('states the next invocation to run when the batch is not done', async () => {
        const output = captureOutput();
        const command = makeCommand({
            output,
            client: {
                runMigration: async () => ({
                    done: false, status: 'dry-run', stats: {}, cursor: 'cursor-2', dryRun: true,
                }),
            },
        });

        await command.run({ environment: 'production', 'dry-run': true }, 'example-noop');
        const text = output.chunks.at(-1);

        assertMatches('Next:', text);
        assertMatches('cursor-2', text);
        assertMatches('--dry-run', text);
    });

    it('renders distinct guidance for each migration conflict error', async () => {
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
    });

    it('fails with a UsageError when the migration id argument is missing', async () => {
        const command = makeCommand({ client: {} });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });
});

function makeCommand(args) {
    const { client, promptForConfirmation, output = captureOutput() } = args;

    return new AdminRunMigrationCommand({
        output,
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
