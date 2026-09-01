import process from 'node:process';
import { assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AdminListMigrationsCommand from '../../../../commands/admin/list-migrations.js';

describe('AdminListMigrationsCommand', ({ it }) => {
    it('prints every migration in registry order with id, status, and description', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const command = makeCommand({
            client: {
                listMigrations: async () => ([
                    { id: 'migration-a', status: 'pending', description: 'First', stats: null, error: null },
                    {
                        id: 'migration-b',
                        status: 'failed',
                        description: 'Second',
                        stats: { scanned: 3 },
                        error: 'boom',
                    },
                ]),
            },
        });

        const code = await command.run({ environment: 'production' });
        const output = stdout.mock.getCall(0).arguments[0];

        assertEqual(0, code);
        assertMatches('migration-a  pending  First', output);
        assertMatches('migration-b  failed  Second', output);
        assertMatches('error: boom', output);
        assertEqual(-1, output.indexOf('null'));
        tracker.reset();
    });
});

function makeCommand(args) {
    const { client } = args;

    return new AdminListMigrationsCommand({
        config: { app: { environments: { production: { origin: 'https://admin.example.test' } } } },
        createClient: () => client,
        promptForValue: async () => 'stub-value',
    });
}
