import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import AdminListMigrationsCommand from '../../../../commands/admin/list-migrations.js';
import captureOutput from '../../helpers/capture-output.js';

describe('AdminListMigrationsCommand', ({ it }) => {
    it('prints every migration in registry order with id, status, and description', async () => {
        const output = captureOutput();
        const command = makeCommand({
            output,
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
        const text = output.chunks[0];

        assertEqual(0, code);
        assertMatches('migration-a  pending  First', text);
        assertMatches('migration-b  failed  Second', text);
        assertMatches('error: boom', text);
        assertEqual(-1, text.indexOf('null'));
    });
});

function makeCommand(args) {
    const { client, output = captureOutput() } = args;

    return new AdminListMigrationsCommand({
        output,
        config: { app: { environments: { production: { origin: 'https://admin.example.test' } } } },
        createClient: () => client,
        promptForValue: async () => 'stub-value',
    });
}
