import process from 'node:process';
import { isNonEmptyString } from 'kixx-assert';
import UsageError from '../../lib/usage-error.js';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { subcommands } from './index.js';


export default class CloudflareCreateWorkerCommand {

    static description = subcommands['create-worker'].description;

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    static options = {
        name: {
            type: 'string',
            description: 'The name of the worker',
        },
    };

    #secrets;

    constructor(args) {
        const { secrets } = args ?? {};
        this.#secrets = secrets;
    }

    async run(options) {
        if (!isNonEmptyString(options.name)) {
            throw new UsageError('cloudflare create-worker requires a --name option');
        }

        const client = new CloudflareApiClient.create(this.#secrets.cloudflare);

        const worker = await client.createWorker({ name: options.name });

        process.stdout.write(`${ JSON.stringify(worker, null, 4) }\n`);

        return 0;
    }
}
