import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { deleteWorkerSecret } from '../../lib/cloudflare/manage-worker-secrets.js';
import defaultFileSystem from '../../lib/file-system.js';
import { wrapText } from '../../lib/text-wrap.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

const COMMAND_NAME = 'kixx.js cloudflare delete-secret';

export default class CloudflareDeleteSecretCommand {

    static description = subcommands['delete-secret'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required environment whose Worker secret will be deleted',
        },
    };

    static positionals = [
        {
            name: 'secret-name',
            description: 'No-longer-declared secret name to remove',
            required: true,
        },
    ];

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    #projectDirectory;
    #cloudflareConfig;
    #secrets;
    #fileSystem;
    #output;
    #createApiClient;
    #deleteWorkerSecret;

    constructor(args) {
        const {
            projectDirectory,
            cloudflareConfig,
            secrets,
            fileSystem = defaultFileSystem,
            output = process.stdout,
            createApiClient = (options) => new CloudflareApiClient(options),
            deleteWorkerSecret: deleteSecret = deleteWorkerSecret,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
        this.#fileSystem = fileSystem;
        this.#output = output;
        this.#createApiClient = createApiClient;
        this.#deleteWorkerSecret = deleteSecret;
    }

    async run(options, ...positionals) {
        const { environment } = options ?? {};
        const [ name, ...extra ] = positionals;
        if (!name || extra.length > 0) {
            throw new UsageError('delete-secret requires exactly one secret-name positional');
        }
        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const apiClient = this.#createApiClient(this.#secrets.cloudflare);
        const result = await this.#deleteWorkerSecret({
            projectDirectory: this.#projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            name,
            command: COMMAND_NAME,
            apiClient,
            fileSystem: this.#fileSystem,
        });

        this.#output.write(wrapText(renderResult(result)));
        return 0;
    }
}

function renderResult(result) {
    return [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
        `Secrets:     ${ result.changedSecretNames.join(', ') }`,
        `Version:     ${ result.versionId } (undeployed)`,
        `BUILD_ID:    ${ result.buildId }`,
        `Wrote ${ result.stateFilepath }`,
        '',
    ].join('\n');
}
