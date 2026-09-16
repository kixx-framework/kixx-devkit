import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import CloudflareSetSecretsCommand from '../../../../commands/cloudflare/set-secrets.js';

describe('CloudflareSetSecretsCommand', ({ it }) => {
    it('defaults to the environment secrets filepath and makes one bulk workflow call', async () => {
        const calls = [];
        const output = makeOutput();
        const command = makeCommand({ calls, output });

        const exitCode = await command.run({ environment: 'production' });

        assertEqual(0, exitCode);
        assertEqual('/app/.env.production.secrets', calls[0].filepath);
        assertEqual(1, calls.length);
        assertEqual('fake-alpha', calls[0].workflow.secrets.ALPHA);
        assertEqual('fake-zeta', calls[0].workflow.secrets.ZETA);
        assertEqual('kixx.js cloudflare set-secrets', calls[0].workflow.command);
        assert(output.text.includes('ALPHA, ZETA'), 'expected sorted changed names');
        assert(!output.text.includes('fake-alpha'), 'expected no secret value in output');
    });

    it('warns about remote secrets the declaration file does not declare', async () => {
        const output = makeOutput();
        const command = makeCommand({ calls: [], output, undeclaredSecretNames: [ 'OLD_SECRET' ] });

        await command.run({ environment: 'production' });

        assert(output.text.includes('Warning:'), 'expected a warning');
        assert(output.text.includes('OLD_SECRET'), 'expected the undeclared name');
        assert(output.text.includes('will not inherit'), 'expected the consequence');
    });

    it('prints no warning when every remote secret is declared', async () => {
        const output = makeOutput();
        const command = makeCommand({ calls: [], output });

        await command.run({ environment: 'production' });

        assert(!output.text.includes('Warning:'), 'expected no warning');
    });

    it('resolves an explicit relative dotenv filepath from the project directory', async () => {
        const calls = [];
        const command = makeCommand({ calls, output: makeOutput() });

        await command.run({ environment: 'production' }, 'ops/rotation.env');

        assertEqual('/app/ops/rotation.env', calls[0].filepath);
    });

    it('rejects missing environment and extra positionals before reading a file', async () => {
        const calls = [];
        const command = makeCommand({ calls, output: makeOutput() });

        const missingEnvironment = await catchAsyncError(() => command.run({}));
        const extra = await catchAsyncError(() => {
            return command.run({ environment: 'production' }, 'one.env', 'two.env');
        });

        assertEqual('UsageError', missingEnvironment.name);
        assertEqual('UsageError', extra.name);
        assertEqual(0, calls.length);
    });
});

function makeCommand(args) {
    const { calls, output, undeclaredSecretNames = [] } = args;

    return new CloudflareSetSecretsCommand({
        projectDirectory: '/app',
        cloudflareConfig: { environments: {} },
        secrets: { cloudflare: { accountId: 'account', apiToken: 'token' } },
        output,
        createApiClient: () => ({}),
        async readEnvValues(options) {
            calls.push({ filepath: options.filepath });
            return { ZETA: 'fake-zeta', ALPHA: 'fake-alpha' };
        },
        async setWorkerSecrets(options) {
            calls[0].workflow = options;
            return {
                environment: 'production',
                workerName: 'example-worker',
                changedSecretNames: [ 'ALPHA', 'ZETA' ],
                versionId: 'new-version-id',
                buildId: 'existing-build-id',
                stateFilepath: '/app/.kixx/cloudflare-state.production.json',
                undeclaredSecretNames,
            };
        },
    });
}

function makeOutput() {
    return {
        text: '',
        write(text) {
            this.text += text;
        },
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
