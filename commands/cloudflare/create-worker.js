import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { subcommands } from './index.js';


export default class CloudflareCreateWorkerCommand {

    static description = subcommands['create-worker'].description;

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    static requiredCloudflareConfig = [ 'name' ];

    #cloudflareConfig;
    #secrets;

    constructor(args) {
        const { cloudflareConfig, secrets } = args ?? {};
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
    }

    async run() {
        const client = new CloudflareApiClient(this.#secrets.cloudflare);

        const worker = await client.createWorker({ name: this.#cloudflareConfig.name });

        process.stdout.write(`${ JSON.stringify(worker, null, 4) }\n`);

        return 0;
    }
}
