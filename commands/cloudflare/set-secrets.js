import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { setWorkerSecrets } from '../../lib/cloudflare/manage-worker-secrets.js';
import { readEnvValues } from '../../lib/env-file.js';
import defaultFileSystem from '../../lib/file-system.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

const COMMAND_NAME = 'kixx.js cloudflare set-secrets';

export default class CloudflareSetSecretsCommand {

    static description = subcommands['set-secrets'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required environment whose Worker secrets will be set',
        },
    };

    static positionals = [
        {
            name: 'dotenv-file',
            description: 'Dotenv values; defaults to .env.<environment>.secrets',
            required: false,
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
    #readEnvValues;
    #setWorkerSecrets;

    constructor(args) {
        const {
            projectDirectory,
            cloudflareConfig,
            secrets,
            fileSystem = defaultFileSystem,
            output = process.stdout,
            createApiClient = (options) => new CloudflareApiClient(options),
            readEnvValues: readValues = readEnvValues,
            setWorkerSecrets: setSecrets = setWorkerSecrets,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
        this.#fileSystem = fileSystem;
        this.#output = output;
        this.#createApiClient = createApiClient;
        this.#readEnvValues = readValues;
        this.#setWorkerSecrets = setSecrets;
    }

    async run(options, ...positionals) {
        const { environment } = options ?? {};
        const [ requestedFilepath, ...extra ] = positionals;
        if (extra.length > 0) {
            throw new UsageError('set-secrets accepts at most one dotenv-file positional');
        }
        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const filepath = requestedFilepath
            ? path.resolve(this.#projectDirectory, requestedFilepath)
            : path.join(this.#projectDirectory, `.env.${ environment }.secrets`);
        const secrets = await this.#readEnvValues({ filepath, fileSystem: this.#fileSystem });
        const apiClient = this.#createApiClient(this.#secrets.cloudflare);
        const result = await this.#setWorkerSecrets({
            projectDirectory: this.#projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            secrets,
            command: COMMAND_NAME,
            apiClient,
            fileSystem: this.#fileSystem,
        });

        this.#output.write(renderResult(result));
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
