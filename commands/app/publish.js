import process from 'node:process';

import assignRelease from '../../lib/publishing/assign-release.js';
import defaultFileSystem from '../../lib/file-system.js';
import publishContent from '../../lib/publishing/publish-content.js';
import resolvePublishingEnvironment from '../../lib/publishing/resolve-publishing-environment.js';
import resolveRunningBuild from '../../lib/publishing/resolve-running-build.js';
import scanContentSources from '../../lib/publishing/scan-content-sources.js';
import { subcommands } from './index.js';

/**
 * A Release that was created successfully but could not be assigned to a
 * build pointer. Carries the Release id so an operator can complete the
 * assignment separately instead of losing track of already-written content.
 */
export class ReleaseAssignmentError extends Error {

    /**
     * @param {string} message - Operator-facing failure description
     * @param {Object} options - Failure details
     * @param {string} options.releaseId - Release that was created
     * @param {string} options.buildId - Build pointer that was not assigned
     * @param {Error} options.cause - Underlying assignment failure
     */
    constructor(message, options) {
        const { releaseId, buildId, cause } = options ?? {};

        super(message, { cause });

        Object.defineProperties(this, {
            name: {
                enumerable: true,
                value: this.constructor.name,
            },
            code: {
                enumerable: true,
                value: this.constructor.name,
            },
            releaseId: {
                enumerable: true,
                value: releaseId,
            },
            buildId: {
                enumerable: true,
                value: buildId,
            },
        });
    }
}

export default class AppPublishCommand {

    static description = subcommands.publish.description;
    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        'build-id': { type: 'string', description: 'Build id; defaults to discovery\'s running build' },
        'dry-run': { type: 'boolean', description: 'Preview the server-backed object diff without writes' },
        verbose: { type: 'boolean', description: 'List every resource and disposition' },
        origin: { type: 'string', description: 'Override the configured Publishing API origin' },
        token: { type: 'string', description: 'Override the configured Publishing API token' },
    };

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options) {
        const connection = resolvePublishingEnvironment({
            environment: options?.environment,
            config: this.#args.config,
            secrets: this.#args.secrets,
            origin: options?.origin,
            token: options?.token,
            createClient: this.#args.createClient,
        });
        const buildId = await (this.#args.resolveRunningBuild ?? resolveRunningBuild)({
            client: connection.client,
            buildId: options?.['build-id'],
        });
        const scan = this.#args.scan ?? scanContentSources;
        const contentSources = await scan(this.#args.projectDirectory, {
            fileSystem: this.#args.fileSystem ?? defaultFileSystem,
        });
        const result = await (this.#args.publishContent ?? publishContent)({
            client: connection.client,
            contentSources,
            dryRun: options?.['dry-run'] ?? false,
            provenance: { client: 'kixx-devkit', intendedForBuildId: buildId },
        });

        if (!result.dryRun) {
            try {
                await (this.#args.assignRelease ?? assignRelease)({
                    client: connection.client,
                    buildId,
                    releaseId: result.releaseId,
                    reason: 'publish',
                });
            } catch (cause) {
                // The Release already exists on the server at this point.
                // Reporting only the assignment failure would hide that and
                // strand the operator without the id needed to recover.
                throw new ReleaseAssignmentError(
                    `Release "${ result.releaseId }" was created but could not be assigned to ` +
                    `build "${ buildId }": ${ cause.message }\n` +
                    'Recover with: kixx.js app assign-build --environment ' +
                    `${ options?.environment } --build-id ${ buildId } --release-id ${ result.releaseId }`,
                    { releaseId: result.releaseId, buildId, cause },
                );
            }
        }

        process.stdout.write(renderPublishResult({
            result: { ...result, buildId },
            environment: connection.environment,
            origin: connection.origin,
            verbose: options?.verbose ?? false,
        }));
        return 0;
    }
}

/**
 * Formats a create-and-assign publishing result.
 * @param {Object} args - Output details
 * @returns {string} Terminal output ending in a newline
 */
export function renderPublishResult(args) {
    const { result, environment, origin, verbose } = args ?? {};
    return renderReleaseResult({
        result,
        environment,
        origin,
        buildId: result.buildId,
        verbose,
    });
}

/**
 * Formats a Release result without exposing credentials.
 * @param {Object} args - Output details
 * @returns {string} Terminal output ending in a newline
 */
export function renderReleaseResult(args) {
    const {
        result,
        environment = result.environment,
        origin = result.origin,
        buildId,
        verbose,
    } = args ?? {};
    const totalCount = result.matchedCount + result.uploadedCount;
    const uploadLabel = result.dryRun ? 'would upload' : 'uploaded';
    const lines = [
        `Environment: ${ environment }`,
        `Origin:      ${ origin }`,
    ];

    if (buildId) {
        lines.push(`BUILD_ID:   ${ buildId }`);
    }

    lines.push(
        '',
        `Resources: ${ totalCount } total; ${ result.matchedCount } matched; ` +
            `${ result.uploadedCount } ${ uploadLabel }`,
        '',
        result.dryRun ? 'Resources that would upload:' : 'Uploaded resources:',
    );
    appendResources(lines, result.uploadedResources);
    lines.push('', 'Files not matched by a publishing convention:');
    appendValues(lines, result.unmatchedFiles);

    if (verbose) {
        lines.push('', 'All resources:');
        appendAllResources(lines, result.resources);
    }

    lines.push('');
    if (result.dryRun) {
        lines.push('Dry run: unvalidated preview; no objects, Release, or build pointer were written.');
    } else {
        lines.push(`Release: ${ result.releaseId }`);
        lines.push(`Objects: ${ result.objectCount }; ${ result.totalBytes } bytes`);
    }
    lines.push('');
    return lines.join('\n');
}

function appendResources(lines, resources) {
    if (resources.length === 0) {
        lines.push('  (none)');
        return;
    }
    for (const resource of resources) {
        lines.push(`  ${ resource.type } ${ resource.pathname || '/' }`);
    }
}

function appendValues(lines, values) {
    if (values.length === 0) {
        lines.push('  (none)');
        return;
    }
    for (const value of values) {
        lines.push(`  ${ value }`);
    }
}

function appendAllResources(lines, resources) {
    if (resources.length === 0) {
        lines.push('  (none)');
        return;
    }
    for (const resource of resources) {
        lines.push(
            `  ${ resource.disposition.padEnd(8) } ${ resource.type } ` +
            `${ resource.pathname || '/' } ${ resource.hash } ${ resource.size } bytes`,
        );
    }
}
