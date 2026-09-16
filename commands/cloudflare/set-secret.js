import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { setWorkerSecrets } from '../../lib/cloudflare/manage-worker-secrets.js';
import defaultFileSystem from '../../lib/file-system.js';
import { wrapText } from '../../lib/text-wrap.js';
import { readSecretValue } from '../../lib/prompt.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

const COMMAND_NAME = 'kixx.js cloudflare set-secret';

export default class CloudflareSetSecretCommand {

    static description = subcommands['set-secret'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required environment whose Worker secret will be set',
        },
    };

    static positionals = [
        {
            name: 'secret-name',
            description: 'Declared secret name to create or replace',
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
    #input;
    #output;
    #createApiClient;
    #setWorkerSecrets;
    #readSecretValue;

    constructor(args) {
        const {
            projectDirectory,
            cloudflareConfig,
            secrets,
            fileSystem = defaultFileSystem,
            input = process.stdin,
            output = process.stdout,
            createApiClient = (options) => new CloudflareApiClient(options),
            setWorkerSecrets: setSecrets = setWorkerSecrets,
            readSecretValue: readValue = readSecretValue,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
        this.#fileSystem = fileSystem;
        this.#input = input;
        this.#output = output;
        this.#createApiClient = createApiClient;
        this.#setWorkerSecrets = setSecrets;
        this.#readSecretValue = readValue;
    }

    async run(options, ...positionals) {
        const { environment } = options ?? {};
        const [ name, ...extra ] = positionals;
        if (!name || extra.length > 0) {
            throw new UsageError('set-secret requires exactly one secret-name positional');
        }
        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const value = await this.#readSecretValue({
            label: `Secret value for ${ name }`,
            input: this.#input,
            output: this.#output,
        });
        const apiClient = this.#createApiClient(this.#secrets.cloudflare);
        const result = await this.#setWorkerSecrets({
            projectDirectory: this.#projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            secrets: { [name]: value },
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
