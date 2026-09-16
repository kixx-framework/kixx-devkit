import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { recoverSecretVersion } from '../../lib/cloudflare/manage-worker-secrets.js';
import { wrapText } from '../../lib/text-wrap.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

export default class CloudflareRecoverSecretVersionCommand {

    static description = subcommands['recover-secret-version'].description;
    static options = {
        environment: { type: 'string', short: 'e', description: 'Required environment to recover' },
    };
    static positionals = [ { name: 'version-id', description: 'Exact secret-only version to recover', required: true } ];
    static requiredSecrets = [ 'cloudflare.accountId', 'cloudflare.apiToken' ];

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options, ...positionals) {
        if (positionals.length !== 1) {
            throw new UsageError('recover-secret-version requires exactly one version-id positional');
        }
        const result = await (this.#args.recoverSecretVersion ?? recoverSecretVersion)({
            ...this.#args,
            environment: options?.environment,
            versionId: positionals[0],
            apiClient: (this.#args.createApiClient ?? ((value) => new CloudflareApiClient(value)))(
                this.#args.secrets.cloudflare,
            ),
        });
        const lines = [
            `Recovered Worker ${ result.workerName } version ${ result.versionId }.`,
            `BUILD_ID: ${ result.buildId }`,
            `Wrote ${ result.stateFilepath }`,
            'Traffic was unchanged. Retry your release command.',
        ];
        if (result.undeclaredSecretNames.length > 0) {
            lines.push(`Warning: later builds omit undeclared secrets: ${ result.undeclaredSecretNames.join(', ') }.`);
        }
        (this.#args.output ?? process.stdout).write(wrapText(`${ lines.join('\n') }\n`));
        return 0;
    }
}
