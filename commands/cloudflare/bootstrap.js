import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import {
    createPreparedWorkerVersion,
    prepareWorkerVersion,
} from '../../lib/cloudflare/create-worker-version.js';
import { readEnvValues } from '../../lib/env-file.js';
import defaultFileSystem from '../../lib/file-system.js';
import { wrapText } from '../../lib/text-wrap.js';
import UsageError from '../../lib/usage-error.js';
import { renderCreated, renderProvisioned, renderResourcesResolved } from './create-worker-version.js';

export default class CloudflareBootstrapCommand {

    static description = 'Create the Worker when missing and deploy its first version with initial secrets';

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required environment whose pristine Worker will be bootstrapped',
        },
    };

    static positionals = [
        {
            name: 'dotenv-file',
            description: 'Initial secret values; defaults to .env.<environment>.secrets',
            required: false,
        },
    ];

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options, ...positionals) {
        const { environment } = options ?? {};
        const [ requestedFilepath, ...extra ] = positionals;

        if (extra.length > 0) {
            throw new UsageError('bootstrap accepts at most one dotenv-file positional');
        }

        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const projectDirectory = this.#args.projectDirectory;
        const fileSystem = this.#args.fileSystem ?? defaultFileSystem;
        const filepath = requestedFilepath
            ? path.resolve(projectDirectory, requestedFilepath)
            : path.join(projectDirectory, `.env.${ environment }.secrets`);
        const initialSecrets = await (this.#args.readEnvValues ?? readEnvValues)({ filepath, fileSystem });
        const apiClient = (this.#args.createApiClient ?? ((value) => new CloudflareApiClient(value)))(
            this.#args.secrets.cloudflare,
        );
        const prepared = await (this.#args.prepareWorkerVersion ?? prepareWorkerVersion)({
            projectDirectory,
            environment,
            cloudflareConfig: this.#args.cloudflareConfig,
            apiClient,
            initialSecrets,
            fileSystem,
        });
        const output = this.#args.output ?? process.stdout;

        output.write(wrapText(renderProvisioned(prepared)));

        if (prepared.outcome === 'resources-resolved') {
            output.write(wrapText(renderResourcesResolved(prepared, environment)));
            return 0;
        }

        const created = await (this.#args.createPreparedWorkerVersion ?? createPreparedWorkerVersion)({
            projectDirectory,
            environment,
            apiClient,
            prepared,
            fileSystem,
        });
        const relativeStateFilepath = path.relative(projectDirectory, created.stateFilepath);

        output.write(wrapText(renderCreated(
            created,
            null,
            created.hashes,
            relativeStateFilepath,
        )));
        output.write(wrapText(renderNextSteps(environment)));
        return 0;
    }
}

function renderNextSteps(environment) {
    return [
        'Next:',
        `  kixx admin accept-invite -e ${ environment }`,
        `  kixx admin create-publishing-token -e ${ environment }`,
        `  kixx cloudflare release -e ${ environment }`,
        '',
    ].join('\n');
}
