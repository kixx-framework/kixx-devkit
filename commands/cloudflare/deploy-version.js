import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import PublishingAPIClient from '../../lib/publishing/publishing-api-client.js';
import deployCloudflareVersion from '../../lib/release/deploy-cloudflare-version.js';
import UsageError from '../../lib/usage-error.js';
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
            description: 'Deploy without verifying the version\'s BUILD_ID through the Publishing API',
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
    #config;
    #secrets;
    #fileSystem;
    #createCloudflareClient;
    #createPublishingClient;
    #deployCloudflareVersion;

    constructor(args) {
        const {
            projectDirectory,
            cloudflareConfig,
            config,
            secrets,
            fileSystem,
            createCloudflareClient = (options) => new CloudflareApiClient(options),
            createPublishingClient = (options) => new PublishingAPIClient(options),
            deployCloudflareVersion: deploy = deployCloudflareVersion,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#config = config;
        this.#secrets = secrets;
        this.#fileSystem = fileSystem;
        this.#createCloudflareClient = createCloudflareClient;
        this.#createPublishingClient = createPublishingClient;
        this.#deployCloudflareVersion = deploy;
    }

    async run(options, versionId) {
        const { environment, force = false } = options ?? {};
        const origin = this.#config?.app?.environments?.[environment]?.origin;
        const token = this.#secrets?.app?.environments?.[environment]?.publishingToken;
        if (!force && (!origin || !token)) {
            throw new UsageError(
                `Missing Publishing API configuration for environment "${ environment }". ` +
                'Configure its origin and publishingToken, or use --force to bypass the guard.',
            );
        }

        const cloudflareClient = this.#createCloudflareClient(this.#secrets.cloudflare);
        const publishingClient = force
            ? null
            : this.#createPublishingClient({ origin, token });
        const result = await this.#deployCloudflareVersion({
            projectDirectory: this.#projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            apiClient: cloudflareClient,
            publishingClient,
            versionId,
            force,
            fileSystem: this.#fileSystem,
        });

        process.stdout.write(renderDeploymentResult(result));

        return 0;
    }
}

/**
 * @param {Object} result - Successful deployment result.
 * @returns {string} Terminal output ending in a newline.
 */
export function renderDeploymentResult(result) {
    const lines = [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
        `Version:     ${ result.versionId }`,
        `BUILD_ID:    ${ result.buildId }`,
        '',
        'Deployed to 100% of traffic.',
    ];

    if (result.guardBypassed) {
        lines.push('Publishing API guard bypassed with --force.');
    }

    lines.push('');
    return lines.join('\n');
}
