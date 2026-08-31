import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { createWorkerVersion } from '../../lib/cloudflare/create-worker-version.js';
import { deployWorkerVersion } from '../../lib/cloudflare/deploy-worker-version.js';
import { readWorkerVersionState } from '../../lib/cloudflare/worker-version-state.js';
import { hasPublishedBuild, readAppState } from '../../lib/app-state.js';
import defaultFileSystem from '../../lib/file-system.js';
import publishApplicationContent from '../../lib/publishing/publish-application-content.js';
import UsageError from '../../lib/usage-error.js';
import { renderPublishResult } from '../app/publish.js';
import {
    renderCreated,
    renderResourcesResolved,
    renderSkipped,
} from './create-worker-version.js';
import { renderDeploymentResult } from './deploy-version.js';
import { subcommands } from './index.js';

const VERSION_HEADING = 'Version phase\n-------------\n';
const PUBLISH_HEADING = 'Publish phase\n-------------\n';
const DEPLOYMENT_HEADING = 'Deployment phase\n----------------\n';

// Release composes the existing operations. Configuration validation remains
// with each owner because every required path is environment-specific.
export default class CloudflareReleaseCommand {

    static description = subcommands.release.description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required environment to release',
        },
        force: {
            type: 'boolean',
            description: 'Create a version even when code inputs are unchanged',
        },
        verbose: {
            type: 'boolean',
            description: 'List every published resource with its hash and disposition',
        },
        origin: {
            type: 'string',
            description: 'Override app.environments.<environment>.origin from .kixx/config.json',
        },
        token: {
            type: 'string',
            description: 'Override app.environments.<environment>.publishingToken from .kixx/secrets.json',
        },
    };

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    #projectDirectory;
    #cloudflareConfig;
    #config;
    #secrets;
    #fileSystem;
    #createApiClient;
    #createWorkerVersion;
    #publishApplicationContent;
    #deployWorkerVersion;

    constructor(args) {
        const {
            projectDirectory,
            cloudflareConfig,
            config,
            secrets,
            fileSystem = defaultFileSystem,
            createApiClient = (options) => new CloudflareApiClient(options),
            createWorkerVersion: createVersion = createWorkerVersion,
            publishApplicationContent: publish = publishApplicationContent,
            deployWorkerVersion: deployVersion = deployWorkerVersion,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#config = config;
        this.#secrets = secrets;
        this.#fileSystem = fileSystem;
        this.#createApiClient = createApiClient;
        this.#createWorkerVersion = createVersion;
        this.#publishApplicationContent = publish;
        this.#deployWorkerVersion = deployVersion;
    }

    async run(options) {
        const {
            environment,
            force = false,
            verbose = false,
        } = options ?? {};

        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const projectDirectory = this.#projectDirectory;
        const fileSystem = this.#fileSystem;
        const apiClient = this.#createApiClient(this.#secrets.cloudflare);
        const previousVersionState = await readWorkerVersionState({
            projectDirectory,
            environment,
            fileSystem,
        });
        const previousAppState = await readAppState({ projectDirectory, environment, fileSystem });
        const versionResult = await this.#createWorkerVersion({
            projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            apiClient,
            force,
            deploy: false,
            fileSystem,
        });

        await this.#reportVersionPhase(versionResult, previousVersionState, environment);

        if (versionResult.outcome === 'resources-resolved') {
            return 0;
        }

        const isCreated = versionResult.outcome === 'created';
        const recordedBuildId = previousVersionState?.buildId;
        const recordedVersionId = previousVersionState?.versionId;
        const isPendingDeployment = versionResult.outcome === 'skipped' &&
            previousVersionState?.deployed === false &&
            recordedBuildId &&
            recordedVersionId &&
            previousAppState?.liveBuildId !== recordedBuildId;
        const isBootstrapRecovery = versionResult.outcome === 'skipped' &&
            previousVersionState?.deployed === true &&
            previousAppState?.liveBuildId === recordedBuildId &&
            !hasPublishedBuild(previousAppState, recordedBuildId);
        const isBootstrapDeployment = isCreated && versionResult.deployed && previousAppState === null;
        const targetBuildId = isCreated ? versionResult.buildId : recordedBuildId;
        const targetVersionId = isCreated ? versionResult.versionId : recordedVersionId;
        const bootstrap = isBootstrapDeployment || isBootstrapRecovery;

        if (isPendingDeployment) {
            process.stdout.write(
                `Resuming undeployed version ${ targetVersionId } (build ${ targetBuildId }) from an ` +
                'interrupted release.\n\n',
            );
        }

        if (bootstrap) {
            process.stdout.write(
                'FIRST RELEASE WINDOW: the new build is serving before it has a content closure.\n' +
                'Requests can fail until the bootstrap publish below completes.\n\n',
            );
        }

        let publishResult;
        try {
            publishResult = await this.#publishApplicationContent({
                projectDirectory,
                environment,
                config: this.#config,
                secrets: this.#secrets,
                buildId: isCreated || isPendingDeployment || isBootstrapRecovery
                    ? targetBuildId
                    : undefined,
                origin: options?.origin,
                token: options?.token,
                bootstrap,
                fileSystem,
            });
        } catch (cause) {
            throw makePublishFailure({
                versionResult,
                environment,
                targetBuildId,
                targetVersionId,
                isPendingDeployment,
                bootstrap,
                cause,
            });
        }

        const publishStateFilepath = publishResult.stateFilepath
            ? path.relative(projectDirectory, publishResult.stateFilepath)
            : null;
        process.stdout.write(PUBLISH_HEADING + renderPublishResult({
            result: publishResult,
            environment: publishResult.environment,
            origin: publishResult.origin,
            verbose,
            stateFilepath: publishStateFilepath,
        }));

        if (!isCreated && !isPendingDeployment && !isBootstrapRecovery) {
            process.stdout.write(
                DEPLOYMENT_HEADING +
                'No deployment happened because no Worker version was created.\n\n',
            );
            return 0;
        }

        if ((isCreated && versionResult.deployed) || isBootstrapRecovery) {
            process.stdout.write(
                DEPLOYMENT_HEADING +
                'The version was already deployed during creation to provision Durable Object namespaces.\n' +
                'Bootstrap publishing is complete; the first-release window is closed.\n\n',
            );
            return 0;
        }

        let deploymentResult;
        try {
            deploymentResult = await this.#deployWorkerVersion({
                projectDirectory,
                environment,
                cloudflareConfig: this.#cloudflareConfig,
                apiClient,
                versionId: targetVersionId,
                fileSystem,
            });
        } catch (cause) {
            throw new Error(
                `Release stopped after content was published for build ${ targetBuildId }, but ` +
                `version ${ targetVersionId } remains undeployed. Re-run cloudflare deploy-version ` +
                `for that version. ${ cause.message }`,
                { cause },
            );
        }

        const deploymentStateFilepath = path.relative(projectDirectory, deploymentResult.stateFilepath);
        process.stdout.write(
            DEPLOYMENT_HEADING + renderDeploymentResult(deploymentResult, deploymentStateFilepath),
        );

        return 0;
    }

    async #reportVersionPhase(result, previousState, environment) {
        if (result.outcome === 'resources-resolved') {
            process.stdout.write(VERSION_HEADING + renderResourcesResolved(result, environment));
            return;
        }

        if (result.outcome === 'skipped') {
            process.stdout.write(VERSION_HEADING + renderSkipped(result, previousState));
            return;
        }

        const newState = await readWorkerVersionState({
            projectDirectory: this.#projectDirectory,
            environment,
            fileSystem: this.#fileSystem,
        });
        const relativeStateFilepath = path.relative(this.#projectDirectory, result.stateFilepath);
        process.stdout.write(VERSION_HEADING + renderCreated(
            result,
            previousState,
            newState,
            relativeStateFilepath,
            { deploymentPending: !result.deployed },
        ));
    }
}

function makePublishFailure(args) {
    const {
        versionResult,
        environment,
        targetBuildId,
        targetVersionId,
        isPendingDeployment,
        bootstrap,
        cause,
    } = args;

    if ((versionResult.outcome === 'created' && !versionResult.deployed) || isPendingDeployment) {
        return new Error(
            `Release stopped while publishing build ${ targetBuildId }. Worker version ` +
            `${ targetVersionId } was created but remains undeployed; traffic did not move. ` +
            `Re-run cloudflare release --environment ${ environment } to resume safely. ` +
            cause.message,
            { cause },
        );
    }

    if (bootstrap) {
        return new Error(
            `First release stopped while bootstrap-publishing build ${ targetBuildId }. The version ` +
            'is already deployed and requests may fail until content is published. Re-run app publish with ' +
            `--environment ${ environment } --build-id ${ targetBuildId } --bootstrap. ${ cause.message }`,
            { cause },
        );
    }

    return new Error(
        `Content-only release stopped during publishing. No version was created and no deployment happened. ` +
        cause.message,
        { cause },
    );
}
