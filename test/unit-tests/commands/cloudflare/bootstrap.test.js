import { describe } from 'kixx-test';
import { assert, assertEqual } from '../../../../lib/vendor/kixx-assert/mod.js';
import CloudflareBootstrapCommand from '../../../../commands/cloudflare/bootstrap.js';
import { subcommands } from '../../../../commands/cloudflare/index.js';

describe('CloudflareBootstrapCommand', ({ it }) => {
    it('is registered with the expected CLI contract', () => {
        assertEqual(subcommands.bootstrap.description, CloudflareBootstrapCommand.description);
        assertEqual('string', CloudflareBootstrapCommand.options.environment.type);
        assertEqual('e', CloudflareBootstrapCommand.options.environment.short);
        assertEqual('dotenv-file', CloudflareBootstrapCommand.positionals[0].name);
        assertEqual(false, CloudflareBootstrapCommand.positionals[0].required);
        assertEqual('cloudflare.accountId', CloudflareBootstrapCommand.requiredSecrets[0]);
        assertEqual('cloudflare.apiToken', CloudflareBootstrapCommand.requiredSecrets[1]);
    });

    it('reads the default dotenv path and passes one preparation unchanged to creation', async () => {
        const calls = [];
        const output = makeOutput();
        const command = makeCommand({ calls, output });

        const exitCode = await command.run({ environment: 'production' });

        assertEqual(0, exitCode);
        assertEqual('/app/.env.production.secrets', calls[0].filepath);
        assertEqual('secret-sentinel', calls[1].initialSecrets.API_SECRET);
        assertEqual(calls[1].apiClient, calls[2].apiClient);
        assertEqual(calls[1].result, calls[2].prepared);
        assertEqual(calls[0].fileSystem, calls[1].fileSystem);
        assertEqual(calls[1].fileSystem, calls[2].fileSystem);
        assert(output.text.includes('Environment: production'), output.text);
        assert(output.text.includes('Worker:      example-worker'), output.text);
        assert(output.text.includes('Created version bootstrap-version-id'), output.text);
        assert(output.text.includes('BUILD_ID: bootstrap-build-id'), output.text);
        assert(output.text.includes('Wrote .kixx/cloudflare-state.production.json'), output.text);
        assert(output.text.includes('ContentAddressableIndexStore'), output.text);
        assert(output.text.includes('kixx.js admin accept-invite -e production'), output.text);
        assert(output.text.includes('kixx.js admin create-publishing-token -e production'), output.text);
        assert(output.text.includes('kixx.js cloudflare release -e production'), output.text);
        assert(!output.text.includes('secret-sentinel'), 'expected no secret value in output');
    });

    it('resolves an explicit relative dotenv path from the project directory', async () => {
        const calls = [];
        const command = makeCommand({ calls, output: makeOutput() });

        await command.run({ environment: 'production' }, 'ops/bootstrap.env');

        assertEqual('/app/ops/bootstrap.env', calls[0].filepath);
    });

    it('reports resolved resources and does not create a version', async () => {
        const calls = [];
        const output = makeOutput();
        const command = makeCommand({ calls, output, outcome: 'resources-resolved' });

        const exitCode = await command.run({ environment: 'production' });

        assertEqual(0, exitCode);
        assertEqual(2, calls.length);
        assert(output.text.includes('environments.production.DOCUMENT_STORE.databaseId'), output.text);
        assert(output.text.includes('= "database-id"'), output.text);
        assert(output.text.includes('Add these IDs, then'), output.text);
        assert(output.text.includes('re-run:'), output.text);
        assert(output.text.includes('No version was created.'), output.text);
        assert(!output.text.includes('secret-sentinel'), 'expected no secret value in output');
    });

    it('reports a created Worker and bucket even when resolution stops the run', async () => {
        const output = makeOutput();
        const command = makeCommand({
            calls: [],
            output,
            outcome: 'resources-resolved',
            provisioned: {
                workerName: 'example-worker',
                workerCreated: true,
                createdBuckets: [ { configPath: 'OBJECT_STORE.buckets.files', name: 'example-files' } ],
            },
        });

        await command.run({ environment: 'production' });

        assert(output.text.includes('Created Worker "example-worker"'), output.text);
        assert(output.text.includes('Created R2 bucket "example-files"'), output.text);
        assert(output.text.includes('No version was created.'), output.text);
    });

    it('rejects a missing environment and extra positionals before reading secrets', async () => {
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
    const { calls, output, outcome = 'prepared', provisioned } = args;
    const fileSystem = {};
    const apiClient = {};
    const prepared = outcome === 'resources-resolved'
        ? {
            outcome,
            resolvedResources: [ {
                configKeyPath: 'DOCUMENT_STORE.databaseId',
                id: 'database-id',
                created: true,
            } ],
            ...provisioned,
        }
        : makePrepared();

    return new CloudflareBootstrapCommand({
        projectDirectory: '/app',
        cloudflareConfig: { environments: {} },
        secrets: { cloudflare: { accountId: 'account', apiToken: 'token' } },
        fileSystem,
        output,
        createApiClient(options) {
            assertEqual('account', options.accountId);
            assertEqual('token', options.apiToken);
            return apiClient;
        },
        async readEnvValues(options) {
            calls.push(options);
            return { API_SECRET: 'secret-sentinel' };
        },
        async prepareWorkerVersion(options) {
            calls.push({ ...options, result: prepared });
            return prepared;
        },
        async createPreparedWorkerVersion(options) {
            calls.push(options);
            return {
                ...prepared,
                outcome: 'created',
                versionId: 'bootstrap-version-id',
                deployed: true,
                reconciliation: {
                    created: [ { class_name: 'ContentAddressableIndexStore' } ],
                },
            };
        },
    });
}

function makePrepared() {
    return {
        outcome: 'prepared',
        environment: 'production',
        workerName: 'example-worker',
        stateFilepath: '/app/.kixx/cloudflare-state.production.json',
        changes: { modules: true, bindings: true, config: true },
        moduleCount: 3,
        buildId: 'bootstrap-build-id',
        versionId: null,
        deployed: false,
        retargetedFrom: null,
        forcedDeploymentClasses: null,
        reconciliation: null,
        hashes: {
            modulesHash: 'aaaaaaaa',
            bindingsHash: 'bbbbbbbb',
            configHash: 'cccccccc',
        },
    };
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
