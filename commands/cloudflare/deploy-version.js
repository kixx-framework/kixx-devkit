import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { deployWorkerVersion } from '../../lib/cloudflare/deploy-worker-version.js';
import { subcommands } from './index.js';

// The Worker name is environment-scoped, so it cannot be declared through
// requiredCloudflareConfig before --environment has been parsed.
export default class CloudflareDeployVersionCommand {

    static description = subcommands['deploy-version'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required environment whose Worker version will be deployed',
        },
        force: {
            type: 'boolean',
            description: 'Deploy without a local record that the version\'s BUILD_ID has published content',
        },
    };

    static positionals = [
        {
            name: 'version-id',
            description: 'Version to deploy; defaults to the version in cloudflare state',
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
    #createApiClient;
    #deployWorkerVersion;
    #now;

    constructor(args) {
        const {
            projectDirectory,
            cloudflareConfig,
            secrets,
            fileSystem,
            createApiClient = (options) => new CloudflareApiClient(options),
            deployWorkerVersion: deploy = deployWorkerVersion,
            now,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
        this.#fileSystem = fileSystem;
        this.#createApiClient = createApiClient;
        this.#deployWorkerVersion = deploy;
        this.#now = now;
    }

    async run(options, versionId) {
        const { environment, force = false } = options ?? {};
        const apiClient = this.#createApiClient(this.#secrets.cloudflare);
        const result = await this.#deployWorkerVersion({
            projectDirectory: this.#projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            apiClient,
            versionId,
            force,
            fileSystem: this.#fileSystem,
            now: this.#now,
        });
        const stateFilepath = path.relative(this.#projectDirectory, result.stateFilepath);

        process.stdout.write(renderDeploymentResult(result, stateFilepath));

        return 0;
    }
}

/**
 * @param {Object} result - Successful deployment result.
 * @param {string} stateFilepath - Project-relative application state path.
 * @returns {string} Terminal output ending in a newline.
 */
export function renderDeploymentResult(result, stateFilepath) {
    return [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
        `Version:     ${ result.versionId }`,
        `BUILD_ID:    ${ result.buildId }`,
        '',
        'Deployed to 100% of traffic.',
        `Wrote ${ stateFilepath }`,
        '',
    ].join('\n');
}
