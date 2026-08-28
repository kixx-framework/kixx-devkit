import process from 'node:process';
import { isPlainObject } from 'kixx-assert';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';


export default class CloudflareCreateWorkerCommand {

    static description = subcommands['create-worker'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Environment whose WORKER configuration will be created',
        },
    };

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    #cloudflareConfig;
    #secrets;

    constructor(args) {
        const { cloudflareConfig, secrets } = args ?? {};
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
    }

    async run(options) {
        const { environment } = options ?? {};
        const configPath = `environments.${ environment }.WORKER`;
        const workerConfig = this.#cloudflareConfig?.environments?.[environment]?.WORKER;

        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        if (!isPlainObject(workerConfig)) {
            throw new UsageError(`Missing required Cloudflare configuration: ${ configPath }`);
        }

        const client = new CloudflareApiClient(this.#secrets.cloudflare);

        const worker = await client.createWorker(workerConfig);

        process.stdout.write(`${ JSON.stringify(worker, null, 4) }\n`);

        return 0;
    }
}
