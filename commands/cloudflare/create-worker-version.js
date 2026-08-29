import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { createWorkerVersion } from '../../lib/cloudflare/create-worker-version.js';
import { readWorkerVersionState } from '../../lib/cloudflare/worker-version-state.js';
import defaultFileSystem from '../../lib/file-system.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

// requiredCloudflareConfig is deliberately not declared. Every config path
// this command needs is under environments.<environment>, which is not
// known until --environment is parsed, but the runner checks
// requiredCloudflareConfig before construction using only static paths.
// Config validation stays inside createWorkerVersion() instead.
export default class CloudflareCreateWorkerVersionCommand {

    static description = subcommands['create-worker-version'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Environment to build and upload a Worker version for',
        },
        force: {
            type: 'boolean',
            description: 'Upload a version even when nothing has changed',
        },
        deploy: {
            type: 'boolean',
            description: 'Route all traffic to the created version',
        },
    };

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    #projectDirectory;
    #cloudflareConfig;
    #secrets;

    constructor(args) {
        const { projectDirectory, cloudflareConfig, secrets } = args ?? {};
        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
    }

    async run(options) {
        const { environment, force = false, deploy = false } = options ?? {};

        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const apiClient = new CloudflareApiClient(this.#secrets.cloudflare);
        const fileSystem = defaultFileSystem;
        const projectDirectory = this.#projectDirectory;

        const previousState = await readWorkerVersionState({ projectDirectory, environment, fileSystem });

        const result = await createWorkerVersion({
            projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            apiClient,
            force,
            deploy,
            fileSystem,
        });

        if (result.outcome === 'resources-created') {
            process.stdout.write(renderResourcesCreated(result, environment));
        } else if (result.outcome === 'skipped') {
            process.stdout.write(renderSkipped(result, previousState));
        } else {
            const newState = await readWorkerVersionState({ projectDirectory, environment, fileSystem });
            const relativeStateFilepath = path.relative(projectDirectory, result.stateFilepath);
            process.stdout.write(renderCreated(result, previousState, newState, relativeStateFilepath));
        }

        return 0;
    }
}

function renderResourcesCreated(result, environment) {
    const lines = [
        `Created ${ result.createdResources.length } resource${ result.createdResources.length === 1 ? '' : 's' }. ` +
        'Add these IDs to cloudflare-config.js, then re-run:',
        '',
    ];

    for (const resource of result.createdResources) {
        lines.push(`  environments.${ environment }.${ resource.configKeyPath }`);
        lines.push(`    = "${ resource.id }"`);
    }

    lines.push('', 'No version was created.', '');

    return lines.join('\n');
}

function renderSkipped(result, previousState) {
    const versionId = previousState?.versionId ?? 'unknown';
    const buildId = previousState?.buildId ?? 'unknown';

    return [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
        '',
        `Nothing changed since version ${ versionId } (build ${ buildId }).`,
        'No version created. Pass --force to upload anyway.',
        '',
    ].join('\n');
}

function renderCreated(result, previousState, newState, relativeStateFilepath) {
    const lines = [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
        '',
        `Bundled ${ result.moduleCount } module${ result.moduleCount === 1 ? '' : 's' }`,
        renderHashLine('modules', result.changes.modules, previousState?.modulesHash, newState.modulesHash),
        renderHashLine('bindings', result.changes.bindings, previousState?.bindingsHash, newState.bindingsHash),
        renderHashLine('config', result.changes.config, previousState?.configHash, newState.configHash),
        '',
        `BUILD_ID: ${ result.buildId }`,
        `Created version ${ result.versionId }`,
        result.deployed ? 'Deployed to 100% of traffic' : 'Not deployed (pass --deploy)',
        `Wrote ${ relativeStateFilepath }`,
        '',
    ];

    return lines.join('\n');
}

function renderHashLine(label, changed, oldHash, newHash) {
    if (!changed) {
        return `  ${ label.padEnd(9) } unchanged`;
    }

    const from = oldHash ? abbreviate(oldHash) : '(none)';
    const to = abbreviate(newHash);

    return `  ${ label.padEnd(9) } changed    ${ from } -> ${ to }`;
}

function abbreviate(hash) {
    return `${ hash.slice(0, 6) }…`;
}
