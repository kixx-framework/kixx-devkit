import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { readWorkerVersionState } from '../../lib/cloudflare/worker-version-state.js';
import defaultFileSystem from '../../lib/file-system.js';
import resolvePublishingEnvironment from '../../lib/publishing/resolve-publishing-environment.js';
import releaseToCloudflare from '../../lib/release/cloudflare-release.js';
import UsageError from '../../lib/usage-error.js';
import { renderReleaseResult } from '../app/publish.js';
import { renderCreated, renderResourcesResolved, renderSkipped } from './create-worker-version.js';
import { renderDeploymentResult } from './deploy-version.js';
import { subcommands } from './index.js';

export default class CloudflareReleaseCommand {

    static description = subcommands.release.description;
    static options = {
        environment: { type: 'string', short: 'e', description: 'Required environment to release' },
        force: { type: 'boolean', description: 'Create a version even when code inputs are unchanged' },
        verbose: { type: 'boolean', description: 'List every published resource and disposition' },
        origin: { type: 'string', description: 'Override the configured Publishing API origin' },
        token: { type: 'string', description: 'Override the configured Publishing API token' },
    };
    static requiredSecrets = [ 'cloudflare.accountId', 'cloudflare.apiToken' ];

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options) {
        const environment = options?.environment;
        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const fileSystem = this.#args.fileSystem ?? defaultFileSystem;
        const connection = resolvePublishingEnvironment({
            environment,
            config: this.#args.config,
            secrets: this.#args.secrets,
            origin: options?.origin,
            token: options?.token,
            createClient: this.#args.createPublishingClient,
        });
        const previousState = await readWorkerVersionState({
            projectDirectory: this.#args.projectDirectory,
            environment,
            fileSystem,
        });
        const result = await (this.#args.release ?? releaseToCloudflare)({
            projectDirectory: this.#args.projectDirectory,
            environment,
            cloudflareConfig: this.#args.cloudflareConfig,
            config: this.#args.config,
            secrets: this.#args.secrets,
            origin: connection.origin,
            token: options?.token,
            force: options?.force ?? false,
            fileSystem,
            cloudflareClient: (this.#args.createApiClient ?? ((value) => new CloudflareApiClient(value)))(
                this.#args.secrets.cloudflare,
            ),
            publishingClient: connection.client,
        });

        await renderResult(result, {
            projectDirectory: this.#args.projectDirectory,
            environment,
            origin: connection.origin,
            verbose: options?.verbose ?? false,
            previousState,
            fileSystem,
        });
        return 0;
    }
}

async function renderResult(result, context) {
    process.stdout.write('Worker preparation\n------------------\n');
    if (result.outcome === 'resources-resolved') {
        process.stdout.write(renderResourcesResolved(result.prepared, context.environment));
        process.stdout.write('Content staging and Worker creation were omitted. Traffic was unchanged.\n\n');
        return;
    }
    if (result.prepared.outcome === 'skipped') {
        process.stdout.write(renderSkipped(result.prepared, context.previousState));
    } else {
        process.stdout.write(`Prepared ${ result.prepared.moduleCount } modules for BUILD_ID ${ result.buildId }.\n\n`);
    }

    process.stdout.write('Content staging\n---------------\n');
    process.stdout.write(renderReleaseResult({
        result: result.release,
        environment: context.environment,
        origin: context.origin,
        buildId: result.buildId,
        verbose: context.verbose,
    }));

    if (result.outcome === 'content-only') {
        process.stdout.write('Worker creation\n---------------\nOmitted because Worker inputs were unchanged.\n\n');
        process.stdout.write('Deployment\n----------\nNo deployment happened; the running build pointer was updated.\n\n');
        return;
    }

    const state = await readWorkerVersionState({
        projectDirectory: context.projectDirectory,
        environment: context.environment,
        fileSystem: context.fileSystem,
    });
    process.stdout.write('Worker creation\n---------------\n');
    process.stdout.write(renderCreated(
        result.created,
        context.previousState,
        state,
        path.relative(context.projectDirectory, result.created.stateFilepath),
        { deploymentPending: !result.created.deployed },
    ));
    process.stdout.write('Deployment\n----------\n');
    if (result.deployment) {
        process.stdout.write(renderDeploymentResult(result.deployment));
    } else {
        process.stdout.write('Deployment occurred during creation after content staging was verified.\n\n');
    }
}
